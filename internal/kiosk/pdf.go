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

// renderPoster draws the current group and product snapshot on print-safe A4 pages.
// document supplies display data and HTTPS QR targets, while dataDirectory locates
// managed images. It returns complete PDF bytes or a context/rendering error.
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
		if err := drawBookingPoster(pdf, document.BookingURL); err != nil {
			return nil, err
		}
		if err := drawPosterText(ctx, pdf, document.Poster.Text, 215, addPage); err != nil {
			return nil, err
		}
	} else {
		featured := len(document.Products) <= 4
		const featuredRowPitch = 48.0
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
			y := 66.0 + float64(position/2)*38
			if featured {
				y = 68 + float64(position/2)*featuredRowPitch
				if len(document.Products) == 1 {
					x = 60.5
				}
			}
			productURL := document.BookingURL + "&product=" + url.QueryEscape(product.ID) + "&scan=1"
			if err := drawProductCard(pdf, product, productImages[product.ID], productURL, x, y, featured); err != nil {
				return nil, err
			}
		}
		lastPageProducts := len(document.Products) % 10
		if lastPageProducts == 0 {
			lastPageProducts = 10
		}
		textY := 66.0 + float64((lastPageProducts+1)/2)*38
		if featured {
			textY = 72 + float64((len(document.Products)+1)/2)*featuredRowPitch
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

// drawPosterHeader repeats group identity, booking instructions, and the booking
// QR on each page. logoName is an optional registered image; rendering errors
// are returned to the caller.
func drawPosterHeader(pdf *fpdf.Fpdf, document posterDocument, logoName string) error {
	pdf.SetFillColor(236, 248, 247)
	pdf.RoundedRect(14, 11, 24, 24, 3, "1234", "F")
	if logoName != "" {
		drawImageFit(pdf, logoName, 16, 13, 20, 20)
	} else {
		drawImageFit(pdf, "teamtaler-mark", 16, 13, 20, 20)
	}
	pdf.SetTextColor(6, 21, 45)
	pdf.SetFont("NotoSans", "B", 17)
	nameWidth := 108.0
	if len(document.Products) == 0 {
		nameWidth = 153
	}
	pdf.SetXY(43, 18.5)
	pdf.CellFormat(nameWidth, 9, fitText(pdf, document.GroupName, nameWidth), "", 0, "L", false, 0, "")
	if len(document.Products) > 0 {
		if err := drawQR(pdf, document.BookingURL, 166, 9, 29); err != nil {
			return err
		}
		pdf.SetFont("NotoSans", "", 7.5)
		pdf.SetTextColor(62, 77, 88)
		pdf.SetXY(157, 39)
		pdf.CellFormat(47, 5, "Buchungsseite", "", 0, "C", false, 0, "")
	}
	pdf.SetFillColor(235, 247, 246)
	pdf.RoundedRect(14, 49, 182, 14, 2.5, "1234", "F")
	pdf.SetTextColor(6, 21, 45)
	pdf.SetFont("NotoSans", "B", 9.5)
	pdf.SetXY(19, 51)
	title := "Produkte auswählen und direkt buchen"
	description := "Produkt scannen · Warenkorb prüfen · Buchung bestätigen"
	if len(document.Products) == 0 {
		title = "In wenigen Schritten zur Buchung"
		description = "QR-Code scannen · Produkte wählen · Buchung bestätigen"
	}
	pdf.CellFormat(172, 5, title, "", 0, "L", false, 0, "")
	pdf.SetTextColor(62, 77, 88)
	pdf.SetFont("NotoSans", "", 7.5)
	pdf.SetXY(19, 56.5)
	pdf.CellFormat(172, 4, description, "", 0, "L", false, 0, "")
	return pdf.Error()
}

// drawBookingPoster gives a product-free template one dominant, centered QR.
// bookingURL points to the ordinary booking page; QR encoding can fail.
func drawBookingPoster(pdf *fpdf.Fpdf, bookingURL string) error {
	pdf.SetFillColor(255, 255, 255)
	pdf.SetDrawColor(214, 223, 228)
	pdf.SetLineWidth(0.25)
	pdf.RoundedRect(28, 71, 154, 137, 4, "1234", "DF")
	pdf.SetTextColor(0, 124, 115)
	pdf.SetFont("NotoSans", "B", 8)
	pdf.SetXY(42, 80)
	pdf.CellFormat(126, 5, "JETZT BUCHEN", "", 0, "C", false, 0, "")
	pdf.SetTextColor(6, 21, 45)
	pdf.SetFont("NotoSans", "B", 15)
	pdf.SetXY(33, 89)
	pdf.CellFormat(144, 8, "Einfach scannen und loslegen", "", 0, "C", false, 0, "")
	if err := drawQR(pdf, bookingURL, 70, 105, 70); err != nil {
		return err
	}
	pdf.SetFont("NotoSans", "B", 10)
	pdf.SetXY(39, 180)
	pdf.CellFormat(132, 7, "QR-Code mit der Kamera scannen", "", 0, "C", false, 0, "")
	pdf.SetTextColor(62, 77, 88)
	pdf.SetFont("NotoSans", "", 8.5)
	pdf.SetXY(39, 190)
	pdf.CellFormat(132, 5, "Die Buchungsseite öffnet sich direkt.", "", 0, "C", false, 0, "")
	return pdf.Error()
}

// drawProductCard prints one bookable product at the given millimeter position.
// featured selects the roomier tile for short posters; imageName is optional.
// The returned error covers QR encoding and PDF drawing failures.
func drawProductCard(pdf *fpdf.Fpdf, product posterProduct, imageName, productURL string, x, y float64, featured bool) error {
	pdf.SetFillColor(255, 255, 255)
	pdf.SetDrawColor(214, 223, 228)
	pdf.SetLineWidth(0.25)
	if featured {
		const imageAndQRSize = 27.0
		pdf.RoundedRect(x, y, 89, 35, 2.6, "1234", "DF")
		drawPosterProductImage(pdf, product.Name, imageName, x+3, y+4, imageAndQRSize)
		if err := drawQR(pdf, productURL, x+59, y+4, imageAndQRSize); err != nil {
			return err
		}
		pdf.SetTextColor(6, 21, 45)
		pdf.SetFont("NotoSans", "B", 8.8)
		lines := pdf.SplitText(product.Name, 24)
		if len(lines) > 2 {
			lines = lines[:2]
			lines[1] = fitText(pdf, lines[1]+"…", 24)
		}
		nameY, priceY := y+11, y+19
		if len(lines) > 1 {
			nameY, priceY = y+8, y+22
		}
		for index, line := range lines {
			pdf.SetXY(x+33, nameY+float64(index)*5.2)
			pdf.CellFormat(24, 5.2, fitText(pdf, line, 24), "", 0, "L", false, 0, "")
		}
		pdf.SetFont("NotoSans", "B", 9.2)
		pdf.SetTextColor(0, 124, 115)
		pdf.SetXY(x+33, priceY)
		pdf.CellFormat(24, 5, fitText(pdf, posterPrice(product), 24), "", 0, "L", false, 0, "")
		return pdf.Error()
	}
	pdf.RoundedRect(x, y, 89, 31.5, 2.6, "1234", "DF")
	drawPosterProductImage(pdf, product.Name, imageName, x+3, y+4, 23.5)
	pdf.SetTextColor(6, 21, 45)
	pdf.SetFont("NotoSans", "B", 8.5)
	lines := pdf.SplitText(product.Name, 30)
	if len(lines) > 2 {
		lines = lines[:2]
		lines[1] = fitText(pdf, lines[1]+"…", 30)
	}
	for index, line := range lines {
		pdf.SetXY(x+30, y+4+float64(index)*5.2)
		pdf.CellFormat(30, 5.2, fitText(pdf, line, 30), "", 0, "L", false, 0, "")
	}
	pdf.SetFont("NotoSans", "B", 9)
	pdf.SetTextColor(0, 124, 115)
	pdf.SetXY(x+30, y+22)
	pdf.CellFormat(30, 5, fitText(pdf, posterPrice(product), 30), "", 0, "L", false, 0, "")
	pdf.SetDrawColor(226, 232, 236)
	pdf.Line(x+62, y+4, x+62, y+27.5)
	if err := drawQR(pdf, productURL, x+63.5, y+4, 23.5); err != nil {
		return err
	}
	return pdf.Error()
}

// drawPosterProductImage paints a photo or branded initial at the visual size of
// the QR modules beside it, leaving the same quiet margin in its square slot.
// The image must already be registered; x, y, and size are millimeters.
func drawPosterProductImage(pdf *fpdf.Fpdf, productName, imageName string, x, y, size float64) {
	inset := size * 0.065
	x += inset
	y += inset
	size -= 2 * inset
	pdf.SetFillColor(235, 247, 246)
	pdf.RoundedRect(x, y, size, size, 2, "1234", "F")
	if imageName != "" {
		drawImageCover(pdf, imageName, x, y, size, size)
		return
	}
	initial := "?"
	if name := []rune(strings.TrimSpace(productName)); len(name) > 0 {
		initial = strings.ToUpper(string(name[0]))
	}
	pdf.SetFont("NotoSans", "B", 16)
	pdf.SetTextColor(0, 124, 115)
	pdf.SetXY(x, y+(size-10)/2)
	pdf.CellFormat(size, 10, initial, "", 0, "C", false, 0, "")
}

// posterPrice returns the current localized amount or a short variable-price
// prompt for the narrow print cards.
func posterPrice(product posterProduct) string {
	if product.PriceMinor.Valid {
		return formatPrice(product.PriceMinor.Int64, product.Currency)
	}
	return "Preis wählen"
}

const (
	posterNoteBottom     = 274.0
	posterNotePadding    = 3.0
	posterNoteLineHeight = 5.3
	posterNoteTextWidth  = 166.0
)

// drawPosterText centers optional editor copy above the footer and paginates it.
// startY is the first free millimeter below page content; addPage repeats the
// poster header and can return a context or drawing error.
func drawPosterText(ctx context.Context, pdf *fpdf.Fpdf, value string, startY float64, addPage func() error) error {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	pdf.SetFont("NotoSans", "", 9)
	lines := make([]string, 0)
	for _, paragraph := range strings.Split(value, "\n") {
		if paragraph == "" {
			lines = append(lines, "")
			continue
		}
		lines = append(lines, pdf.SplitText(paragraph, posterNoteTextWidth)...)
	}
	for offset := 0; offset < len(lines); {
		if err := ctx.Err(); err != nil {
			return err
		}
		capacity := int((posterNoteBottom - startY - 2*posterNotePadding) / posterNoteLineHeight)
		if capacity < 1 || (offset == 0 && len(lines) > capacity && startY > 70) {
			if err := addPage(); err != nil {
				return err
			}
			startY = 70
			continue
		}
		end := offset + capacity
		if end > len(lines) {
			end = len(lines)
		}
		drawPosterNote(pdf, lines[offset:end], posterNoteBottom)
		offset = end
		if offset < len(lines) {
			if err := addPage(); err != nil {
				return err
			}
			startY = 70
		}
	}
	return pdf.Error()
}

// drawPosterNote places wrapped lines in a full-width capsule sized to the text height.
// bottom is the lower edge of the capsule in millimeters above the footer.
func drawPosterNote(pdf *fpdf.Fpdf, lines []string, bottom float64) {
	pdf.SetFont("NotoSans", "", 9)
	const boxWidth = 182.0
	boxHeight := 2*posterNotePadding + float64(len(lines))*posterNoteLineHeight
	x, y := 14.0, bottom-boxHeight
	pdf.SetFillColor(247, 249, 250)
	pdf.SetDrawColor(225, 232, 236)
	pdf.SetLineWidth(0.2)
	pdf.RoundedRect(x, y, boxWidth, boxHeight, 2.5, "1234", "DF")
	pdf.SetTextColor(62, 77, 88)
	for index, line := range lines {
		pdf.SetXY(x+7, y+posterNotePadding+float64(index)*posterNoteLineHeight)
		pdf.CellFormat(boxWidth-14, posterNoteLineHeight, line, "", 0, "C", false, 0, "")
	}
}

// drawPosterFooter repeats the TeamTaler mark, compact slogan, and page count.
func drawPosterFooter(pdf *fpdf.Fpdf) {
	pdf.SetDrawColor(214, 223, 228)
	pdf.SetLineWidth(0.25)
	pdf.Line(14, 279, 196, 279)
	pdf.SetTextColor(90, 105, 120)
	pdf.SetFont("NotoSans", "", 7.5)
	pdf.SetXY(14, 284)
	pdf.CellFormat(65, 5, "Scannen · Buchen · Fertig", "", 0, "L", false, 0, "")
	drawImageFit(pdf, "teamtaler-mark", 85, 282.5, 8, 8)
	pdf.SetTextColor(6, 21, 45)
	pdf.SetFont("NotoSans", "B", 10)
	pdf.SetXY(96, 282.5)
	pdf.CellFormat(40, 8, "TeamTaler", "", 0, "L", false, 0, "")
	pdf.SetTextColor(90, 105, 120)
	pdf.SetFont("NotoSans", "", 7.5)
	pdf.SetXY(169, 284)
	pdf.CellFormat(27, 5, fmt.Sprintf("%d / {nb}", pdf.PageNo()), "", 0, "R", false, 0, "")
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

// drawImageCover center-crops one registered image into a rounded print tile.
// Coordinates and dimensions are millimeters; missing images leave the tile
// background visible without changing the card layout.
func drawImageCover(pdf *fpdf.Fpdf, name string, x, y, width, height float64) {
	info := pdf.GetImageInfo(name)
	if info == nil || info.Width() <= 0 || info.Height() <= 0 {
		return
	}
	ratio := info.Width() / info.Height()
	actualWidth, actualHeight := width, width/ratio
	if actualHeight < height {
		actualHeight = height
		actualWidth = height * ratio
	}
	pdf.ClipRoundedRect(x, y, width, height, 2, false)
	pdf.ImageOptions(name, x+(width-actualWidth)/2, y+(height-actualHeight)/2, actualWidth, actualHeight, false, fpdf.ImageOptions{ImageType: "PNG"}, 0, "")
	pdf.ClipEnd()
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
