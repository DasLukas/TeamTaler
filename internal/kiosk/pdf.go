package kiosk

import (
	"bytes"
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"image"
	_ "image/png"
	"io"
	"net/url"
	"os"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/exporting/tabular"
	"github.com/DasLukas/TeamTaler/internal/media"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
	"github.com/go-pdf/fpdf"
	qrcode "github.com/skip2/go-qrcode"
)

type posterProduct struct {
	ID         string
	Name       string
	PriceMinor sql.NullInt64
	Currency   string
	ImageKey   sql.NullString
}

//go:embed assets/teamtaler-mark.png
var teamtalerMarkPNG []byte

type posterDocument struct {
	Poster     Poster
	GroupID    string
	GroupName  string
	LogoKey    sql.NullString
	Products   []posterProduct
	BookingURL string
}

// PDF returns a complete portrait A4 document from current group and product
// data. ctx bounds the database work and rendering; membership identifies the
// authorized group administrator, and posterID identifies its saved template.
// It returns PDF bytes or authorization, disabled-feature, unavailable-product,
// not-found, storage, context, or rendering errors. QR links use PublicURL and
// remain within the configured TeamTaler origin.
// Example: pdf, err := service.PDF(ctx, membership, posterID).
func (s Service) PDF(ctx context.Context, membership domain.Membership, posterID string) ([]byte, error) {
	var document posterDocument
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireAdministration(ctx, tx, membership); err != nil {
			return err
		}
		var enabled bool
		if err := tx.QueryRowContext(ctx, `SELECT g.name,g.logo_key,settings.kiosk_enabled FROM groups g
			JOIN group_settings settings ON settings.group_id=g.id WHERE g.id=?`, membership.GroupID).
			Scan(&document.GroupName, &document.LogoKey, &enabled); err != nil {
			return err
		}
		if !enabled {
			return fmt.Errorf("%w: kiosk is disabled", domain.ErrConflict)
		}
		document.GroupID = membership.GroupID
		if err := tx.QueryRowContext(ctx, `SELECT id,name,text,version,is_default FROM kiosk_posters WHERE group_id=? AND id=?`, membership.GroupID, posterID).
			Scan(&document.Poster.ID, &document.Poster.Name, &document.Poster.Text, &document.Poster.Version, &document.Poster.IsDefault); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return domain.ErrNotFound
			}
			return err
		}
		productIDs, err := posterProductIDs(ctx, tx, membership.GroupID, posterID)
		if err != nil {
			return err
		}
		document.Poster.ProductIDs = productIDs
		if !document.Poster.IsDefault && len(productIDs) == 0 {
			return fmt.Errorf("%w: custom poster has no products; update or delete the template", domain.ErrConflict)
		}
		products := make([]posterProduct, 0, len(productIDs))
		for _, id := range productIDs {
			var item posterProduct
			err := tx.QueryRowContext(ctx, `SELECT p.id,p.name,p.price_minor,g.currency,p.image_key FROM products p
				JOIN categories c ON c.id=p.category_id AND c.group_id=p.group_id
				JOIN groups g ON g.id=p.group_id
				WHERE p.group_id=? AND p.id=? AND p.active=1 AND p.deleted_at IS NULL AND c.active=1`, membership.GroupID, id).
				Scan(&item.ID, &item.Name, &item.PriceMinor, &item.Currency, &item.ImageKey)
			if errors.Is(err, sql.ErrNoRows) {
				return fmt.Errorf("%w: selected product is unavailable; update the poster template", domain.ErrConflict)
			}
			if err != nil {
				return err
			}
			products = append(products, item)
		}
		document.Products = products
		return nil
	})
	if err != nil {
		return nil, err
	}
	base := strings.TrimRight(s.PublicURL, "/")
	if base == "" {
		return nil, fmt.Errorf("public URL is required for kiosk PDFs")
	}
	document.BookingURL = base + "/book?group=" + url.QueryEscape(document.GroupID)
	return renderPoster(ctx, document, s.DataDirectory)
}

func renderPoster(ctx context.Context, document posterDocument, dataDirectory string) ([]byte, error) {
	pdf := fpdf.NewCustom(&fpdf.InitType{OrientationStr: "P", UnitStr: "mm", SizeStr: "A4"})
	if err := tabular.RegisterNotoSans(pdf); err != nil {
		return nil, err
	}
	pdf.SetMargins(14, 12, 14)
	pdf.SetAutoPageBreak(false, 0)
	pdf.SetCompression(true)
	pdf.SetTitle(document.Poster.Name, true)
	pdf.SetAuthor("TeamTaler", true)
	pdf.SetCreator("TeamTaler", true)
	pdf.SetLang("de-DE")
	pdf.AliasNbPages("{nb}")
	pdf.RegisterImageOptionsReader("teamtaler-mark", fpdf.ImageOptions{ImageType: "PNG"}, bytes.NewReader(teamtalerMarkPNG))
	if err := pdf.Error(); err != nil {
		return nil, err
	}
	logoName := registerManagedImage(pdf, dataDirectory, document.LogoKey, "group-logo")
	productImages := make(map[string]string, len(document.Products))
	for _, product := range document.Products {
		productImages[product.ID] = registerManagedImage(pdf, dataDirectory, product.ImageKey, "product-"+product.ID)
	}
	pdf.SetFooterFunc(func() { drawPosterFooter(pdf) })
	addPage := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		pdf.AddPage()
		if err := drawPosterHeader(pdf, document, logoName); err != nil {
			return err
		}
		return pdf.Error()
	}
	if err := addPage(); err != nil {
		return nil, err
	}
	if len(document.Products) == 0 {
		if err := drawQR(pdf, document.BookingURL, 69, 81, 72); err != nil {
			return nil, err
		}
		pdf.SetFont("NotoSans", "", 11)
		pdf.SetTextColor(26, 40, 58)
		pdf.SetXY(14, 159)
		pdf.CellFormat(182, 8, "QR-Code scannen und Buchungsseite öffnen", "", 0, "C", false, 0, "")
		if err := drawPosterText(ctx, pdf, document.Poster.Text, 177, addPage); err != nil {
			return nil, err
		}
	} else {
		for index, product := range document.Products {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if index > 0 && index%10 == 0 {
				if err := addPage(); err != nil {
					return nil, err
				}
			}
			position := index % 10
			x := 14.0 + float64(position%2)*93
			y := 55.0 + float64(position/2)*43
			productURL := document.BookingURL + "&product=" + url.QueryEscape(product.ID) + "&scan=1"
			if err := drawProductCard(pdf, product, productImages[product.ID], productURL, x, y); err != nil {
				return nil, err
			}
		}
		textY := 55.0 + float64((len(document.Products)%10+1)/2)*43
		if len(document.Products)%10 == 0 {
			textY = 270
		}
		if err := drawPosterText(ctx, pdf, document.Poster.Text, textY, addPage); err != nil {
			return nil, err
		}
	}
	if err := pdf.Error(); err != nil {
		return nil, err
	}
	var output bytes.Buffer
	if err := pdf.Output(&output); err != nil {
		return nil, fmt.Errorf("render kiosk poster: %w", err)
	}
	return output.Bytes(), nil
}

func drawPosterHeader(pdf *fpdf.Fpdf, document posterDocument, logoName string) error {
	pdf.SetFillColor(250, 252, 253)
	pdf.Rect(0, 0, 210, 49, "F")
	if logoName != "" {
		drawImageFit(pdf, logoName, 14, 12, 17, 17)
	} else {
		drawImageFit(pdf, "teamtaler-mark", 14, 12, 17, 17)
	}
	pdf.SetTextColor(6, 21, 45)
	pdf.SetFont("NotoSans", "B", 17)
	pdf.SetXY(35, 14)
	pdf.CellFormat(117, 8, fitText(pdf, document.GroupName, 117), "", 0, "L", false, 0, "")
	pdf.SetFont("NotoSans", "", 9)
	pdf.SetXY(35, 24)
	pdf.CellFormat(117, 6, "Scan & Go · "+fitText(pdf, document.Poster.Name, 96), "", 0, "L", false, 0, "")
	if len(document.Products) > 0 {
		if err := drawQR(pdf, document.BookingURL, 165, 6, 31); err != nil {
			return err
		}
		pdf.SetFont("NotoSans", "", 7)
		pdf.SetXY(155, 38)
		pdf.CellFormat(51, 5, "Zur Buchungsseite", "", 0, "C", false, 0, "")
	}
	pdf.SetDrawColor(0, 124, 115)
	pdf.SetLineWidth(0.5)
	pdf.Line(14, 48, 196, 48)
	return pdf.Error()
}

func drawProductCard(pdf *fpdf.Fpdf, product posterProduct, imageName, productURL string, x, y float64) error {
	pdf.SetFillColor(255, 255, 255)
	pdf.SetDrawColor(214, 223, 228)
	pdf.SetLineWidth(0.25)
	pdf.RoundedRect(x, y, 89, 38, 2.2, "1234", "DF")
	if imageName != "" {
		drawImageFit(pdf, imageName, x+3, y+5, 20, 20)
	} else {
		pdf.SetFillColor(241, 246, 246)
		pdf.Rect(x+3, y+5, 20, 20, "F")
		pdf.SetFont("NotoSans", "B", 8)
		pdf.SetTextColor(98, 113, 124)
		pdf.SetXY(x+3, y+11)
		pdf.CellFormat(20, 5, "Produkt", "", 0, "C", false, 0, "")
	}
	pdf.SetTextColor(6, 21, 45)
	pdf.SetFont("NotoSans", "B", 8.2)
	lines := pdf.SplitText(product.Name, 34)
	if len(lines) > 2 {
		lines = lines[:2]
		lines[1] = fitText(pdf, lines[1]+"…", 34)
	}
	for index, line := range lines {
		pdf.SetXY(x+26, y+5+float64(index)*4.8)
		pdf.CellFormat(34, 4.8, line, "", 0, "L", false, 0, "")
	}
	pdf.SetFont("NotoSans", "", 8)
	pdf.SetTextColor(62, 77, 88)
	price := "Preis frei wählbar"
	if product.PriceMinor.Valid {
		price = formatPrice(product.PriceMinor.Int64, product.Currency)
	}
	pdf.SetXY(x+26, y+25)
	pdf.CellFormat(35, 5, fitText(pdf, price, 35), "", 0, "L", false, 0, "")
	return drawQR(pdf, productURL, x+62, y+6, 24)
}

func drawPosterText(ctx context.Context, pdf *fpdf.Fpdf, value string, startY float64, addPage func() error) error {
	if value == "" {
		return nil
	}
	const left, width, bottom = 18.0, 174.0, 271.0
	if startY > bottom-18 {
		if err := addPage(); err != nil {
			return err
		}
		startY = 57
	}
	pdf.SetFont("NotoSans", "B", 10)
	pdf.SetTextColor(6, 21, 45)
	pdf.SetXY(left, startY)
	pdf.CellFormat(width, 7, "Hinweis", "", 0, "L", false, 0, "")
	pdf.SetFont("NotoSans", "", 9)
	lines := make([]string, 0)
	for _, paragraph := range strings.Split(value, "\n") {
		if paragraph == "" {
			lines = append(lines, "")
			continue
		}
		lines = append(lines, pdf.SplitText(paragraph, width)...)
	}
	y := startY + 9
	for _, line := range lines {
		if err := ctx.Err(); err != nil {
			return err
		}
		if y+5 > bottom {
			if err := addPage(); err != nil {
				return err
			}
			y = 57
		}
		pdf.SetXY(left, y)
		pdf.CellFormat(width, 5, line, "", 0, "L", false, 0, "")
		y += 5.3
	}
	return pdf.Error()
}

func drawPosterFooter(pdf *fpdf.Fpdf) {
	pdf.SetDrawColor(214, 223, 228)
	pdf.SetLineWidth(0.25)
	pdf.Line(14, 279, 196, 279)
	drawImageFit(pdf, "teamtaler-mark", 85, 282.5, 8, 8)
	pdf.SetTextColor(6, 21, 45)
	pdf.SetFont("NotoSans", "B", 10)
	pdf.SetXY(96, 282.5)
	pdf.CellFormat(40, 8, "TeamTaler", "", 0, "L", false, 0, "")
}

func drawQR(pdf *fpdf.Fpdf, value string, x, y, size float64) error {
	code, err := qrcode.New(value, qrcode.Medium)
	if err != nil {
		return fmt.Errorf("encode kiosk QR: %w", err)
	}
	modules := code.Bitmap()
	if len(modules) == 0 {
		return fmt.Errorf("kiosk QR has no modules")
	}
	pdf.SetFillColor(255, 255, 255)
	pdf.Rect(x, y, size, size, "F")
	moduleSize := size / float64(len(modules))
	pdf.SetFillColor(6, 21, 45)
	for row, cells := range modules {
		for col, black := range cells {
			if black {
				pdf.Rect(x+float64(col)*moduleSize, y+float64(row)*moduleSize, moduleSize+0.015, moduleSize+0.015, "F")
			}
		}
	}
	return pdf.Error()
}

func registerManagedImage(pdf *fpdf.Fpdf, dataDirectory string, key sql.NullString, name string) string {
	if !key.Valid || !media.ValidImageKey(key.String) {
		return ""
	}
	path, err := media.ResolveImage(dataDirectory, key.String)
	if err != nil {
		return ""
	}
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	const maximumImageBytes = 10 << 20
	raw, err := io.ReadAll(io.LimitReader(file, maximumImageBytes+1))
	if err != nil || len(raw) > maximumImageBytes {
		return ""
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || config.Width < 1 || config.Height < 1 || int64(config.Width)*int64(config.Height) > 8_000_000 {
		return ""
	}
	pdf.RegisterImageOptionsReader(name, fpdf.ImageOptions{ImageType: "PNG"}, bytes.NewReader(raw))
	if pdf.Error() != nil {
		return ""
	}
	return name
}

func drawImageFit(pdf *fpdf.Fpdf, name string, x, y, width, height float64) {
	info := pdf.GetImageInfo(name)
	if info == nil || info.Width() <= 0 || info.Height() <= 0 {
		return
	}
	ratio := info.Width() / info.Height()
	actualWidth, actualHeight := width, width/ratio
	if actualHeight > height {
		actualHeight = height
		actualWidth = height * ratio
	}
	pdf.ImageOptions(name, x+(width-actualWidth)/2, y+(height-actualHeight)/2, actualWidth, actualHeight, false, fpdf.ImageOptions{ImageType: "PNG"}, 0, "")
}

func fitText(pdf *fpdf.Fpdf, value string, width float64) string {
	if pdf.GetStringWidth(value) <= width {
		return value
	}
	runes := []rune(value)
	for len(runes) > 0 && pdf.GetStringWidth(string(runes)+"…") > width {
		runes = runes[:len(runes)-1]
	}
	return string(runes) + "…"
}

func formatPrice(minor int64, currency string) string {
	exponent := int(platform.CurrencyExponent(currency))
	if exponent == 0 {
		return fmt.Sprintf("%d %s", minor, currency)
	}
	divisor := int64(1)
	for i := 0; i < exponent; i++ {
		divisor *= 10
	}
	return fmt.Sprintf("%d,%0*d %s", minor/divisor, exponent, minor%divisor, currency)
}
