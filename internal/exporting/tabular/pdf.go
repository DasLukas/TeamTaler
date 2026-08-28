package tabular

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"fmt"
	"image"
	_ "image/jpeg"
	"image/png"
	"io"
	"math"
	"sort"
	"strings"

	"github.com/go-pdf/fpdf"
)

const (
	pageWidthMM           = 297.0
	pageHeightMM          = 210.0
	pageMarginMM          = 10.0
	pageContentWidth      = pageWidthMM - 2*pageMarginMM
	compactHeaderDividerY = 28.0
	compactTableHeaderY   = 31.0
	detailHeaderDividerY  = 36.0
	detailTableHeaderY    = 39.0
	pageBottomY           = pageHeightMM - pageMarginMM
	bodyFontSize          = 8.0
	bodyLineHeight        = 4.1
	cellPadding           = 1.3
	cellImageSizeMM       = 7.0
	cellImageGapMM        = 1.2
	decoratedRowMM        = 9.6
	minimumColumnMM       = 20.0
	maximumColumnMM       = 75.0
	brandRed              = 0
	brandGreen            = 124
	brandBlue             = 115
	brandDarkRed          = 6
	brandDarkGreen        = 21
	brandDarkBlue         = 45

	regularFontFamily = "NotoSans"
)

//go:embed assets/NotoSans-Regular.ttf
var notoSansRegular []byte

//go:embed assets/NotoSans-SemiBold.ttf
var notoSansSemibold []byte

type columnBand struct {
	indexes []int
	widths  []float64
}

type cellImageRegistry map[[sha256.Size]byte]string

// WritePDF validates document and writes a deterministic, Unicode-capable A4
// landscape PDF to output. Every page has the group logo or TeamTaler fallback
// mark, optional group name, centered title, localized export timestamp, page
// n/m, and a repeated table header. Wide tables use horizontal bands with
// identity columns repeated; tall rows wrap and continue without clipping.
//
// Validation, image normalization, layout, and write failures are returned to
// the caller. The caller should render to a restrictive temporary file before
// beginning an HTTP response.
//
// Example: err := tabular.WritePDF(file, document)
func WritePDF(output io.Writer, document Document) error {
	return WritePDFContext(context.Background(), output, document)
}

// WritePDFContext writes the same validated PDF as WritePDF and aborts between
// rows and output writes when ctx is cancelled or reaches its deadline. Context
// and output must be non-nil. It returns validation, layout, cancellation,
// deadline, or write errors.
//
// Example: err := tabular.WritePDFContext(ctx, file, document)
func WritePDFContext(ctx context.Context, output io.Writer, document Document) error {
	if ctx == nil {
		return fmt.Errorf("PDF context must not be nil")
	}
	if output == nil {
		return fmt.Errorf("PDF output must not be nil")
	}
	if err := document.Validate(); err != nil {
		return fmt.Errorf("validate PDF document: %w", err)
	}

	countingPDF := newPDFDocument(document)
	totalPages, err := renderPDFPages(ctx, countingPDF, document, 0)
	if err != nil {
		return err
	}
	countingPDF = nil

	pdf := newPDFDocument(document)
	if _, err := renderPDFPages(ctx, pdf, document, totalPages); err != nil {
		return err
	}
	if err := pdf.Output(contextWriter{context: ctx, writer: output}); err != nil {
		return fmt.Errorf("write PDF: %w", err)
	}
	return nil
}

// newPDFDocument creates one consistently configured A4-landscape renderer.
func newPDFDocument(document Document) *fpdf.Fpdf {
	pdf := fpdf.NewCustom(&fpdf.InitType{
		OrientationStr: "L",
		UnitStr:        "mm",
		SizeStr:        "A4",
	})
	pdf.AddUTF8FontFromBytes(regularFontFamily, "", notoSansRegular)
	pdf.AddUTF8FontFromBytes(regularFontFamily, "B", notoSansSemibold)
	pdf.SetCatalogSort(true)
	pdf.SetCompression(true)
	pdf.SetMargins(pageMarginMM, pageMarginMM, pageMarginMM)
	pdf.SetAutoPageBreak(false, pageMarginMM)
	pdf.SetCreationDate(document.ExportedAt)
	pdf.SetModificationDate(document.ExportedAt)
	pdf.SetTitle(pdfExportTitle(document), true)
	pdf.SetSubject("TeamTaler table export", true)
	pdf.SetAuthor("TeamTaler", true)
	pdf.SetCreator("TeamTaler", true)
	pdf.SetLang("de-DE")
	return pdf
}

func pdfExportTitle(document Document) string {
	return document.ExportedAt.Format("2006-01-02") + "_" + strings.TrimSpace(document.Title)
}

// renderPDFPages draws every horizontal band and row and returns the resulting
// page count. A zero totalPages value is used only by the counting pass.
func renderPDFPages(ctx context.Context, pdf *fpdf.Fpdf, document Document, totalPages int) (int, error) {
	logoRegistered := registerLogo(pdf, document.LogoPNG)
	subjectRegistered := registerHeaderImage(pdf, "teamtaler-export-subject", document.SubjectImagePNG)
	cellImages, err := registerCellImages(ctx, pdf, document)
	if err != nil {
		return 0, err
	}
	pdf.SetFont(regularFontFamily, "", bodyFontSize)
	bands := buildColumnBands(pdf, document)
	if len(bands) == 0 {
		return 0, fmt.Errorf("calculate PDF column layout: no column bands")
	}

	currentBand := bands[0]
	dividerY, tableY := documentHeaderPositions(document)
	bodyStartY := tableY
	pdf.SetHeaderFuncMode(func() {
		drawDocumentHeader(pdf, document, logoRegistered, subjectRegistered, totalPages, dividerY)
		bodyStartY = drawTableHeader(pdf, document, currentBand, tableY)
		pdf.SetXY(pageMarginMM, bodyStartY)
	}, false)

	for _, band := range bands {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		currentBand = band
		pdf.AddPage()
		if err := pdf.Error(); err != nil {
			return 0, fmt.Errorf("start PDF page: %w", err)
		}
		if len(document.Rows) == 0 {
			continue
		}
		for rowIndex, row := range document.Rows {
			if err := ctx.Err(); err != nil {
				return 0, err
			}
			renderWrappedRow(pdf, document, band, row, rowIndex, &bodyStartY, cellImages)
			if err := pdf.Error(); err != nil {
				return 0, fmt.Errorf("render PDF row %d: %w", rowIndex, err)
			}
		}
	}
	return pdf.PageNo(), nil
}

func registerCellImages(ctx context.Context, pdf *fpdf.Fpdf, document Document) (cellImageRegistry, error) {
	registered := make(cellImageRegistry)
	for rowIndex, row := range document.Rows {
		if rowIndex%64 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		for _, cell := range row.Cells {
			if len(cell.ImagePNG) == 0 {
				continue
			}
			digest := sha256.Sum256(cell.ImagePNG)
			if _, exists := registered[digest]; exists {
				continue
			}
			normalized, ok := normalizePDFImage(cell.ImagePNG)
			if !ok {
				registered[digest] = ""
				continue
			}
			name := fmt.Sprintf("teamtaler-cell-image-%x", digest)
			pdf.RegisterImageOptionsReader(name, fpdf.ImageOptions{ImageType: "PNG"}, bytes.NewReader(normalized))
			if pdf.Error() != nil {
				registered[digest] = ""
				continue
			}
			registered[digest] = name
		}
	}
	return registered, nil
}

func registerLogo(pdf *fpdf.Fpdf, source []byte) bool {
	return registerHeaderImage(pdf, "teamtaler-export-logo", source)
}

func registerHeaderImage(pdf *fpdf.Fpdf, name string, source []byte) bool {
	logo, ok := normalizePDFImage(source)
	if !ok {
		return false
	}
	pdf.RegisterImageOptionsReader(name, fpdf.ImageOptions{ImageType: "PNG"}, bytes.NewReader(logo))
	return pdf.Error() == nil
}

func normalizePDFImage(source []byte) ([]byte, bool) {
	if len(source) == 0 || len(source) > maxLogoBytes {
		return nil, false
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(source))
	if err != nil || config.Width < 1 || config.Height < 1 || config.Width > 4096 || config.Height > 4096 || int64(config.Width)*int64(config.Height) > 8_000_000 {
		return nil, false
	}
	decoded, _, err := image.Decode(bytes.NewReader(source))
	if err != nil {
		return nil, false
	}
	var normalized bytes.Buffer
	if err := png.Encode(&normalized, decoded); err != nil || normalized.Len() > maxLogoBytes {
		return nil, false
	}
	return normalized.Bytes(), true
}

func drawDocumentHeader(pdf *fpdf.Fpdf, document Document, logoRegistered, subjectRegistered bool, totalPages int, dividerY float64) {
	regionWidth := pageContentWidth / 3
	brandNameX := pageMarginMM + 15
	brandImageCenterX := pageMarginMM + 6
	if logoRegistered {
		info := pdf.GetImageInfo("teamtaler-export-logo")
		if info != nil {
			width, height := fitRectangle(info.Width(), info.Height(), 34, 12)
			pdf.ImageOptions(
				"teamtaler-export-logo",
				pageMarginMM,
				pageMarginMM+(12-height)/2,
				width,
				height,
				false,
				fpdf.ImageOptions{ImageType: "PNG"},
				0,
				"",
			)
			brandNameX = pageMarginMM + width + 3
			brandImageCenterX = pageMarginMM + width/2
		}
	} else {
		drawFallbackMark(pdf, pageMarginMM, pageMarginMM)
	}
	drawGroupName(pdf, document.GroupName, brandNameX, pageMarginMM, pageMarginMM+regionWidth-brandNameX)
	if strings.TrimSpace(document.SubjectName) != "" {
		drawSubjectIdentity(pdf, document.SubjectName, subjectRegistered, brandImageCenterX, brandNameX, pageMarginMM+14, pageMarginMM+regionWidth-brandNameX)
	}

	pdf.SetTextColor(brandDarkRed, brandDarkGreen, brandDarkBlue)
	if strings.TrimSpace(document.Subtitle) == "" {
		drawCenteredTitle(pdf, document.Title, pageMarginMM+regionWidth, pageMarginMM, regionWidth)
	} else {
		drawCenteredStatementTitle(pdf, document.Title, document.Subtitle, pageMarginMM+regionWidth, pageMarginMM, regionWidth)
	}

	pdf.SetFont(regularFontFamily, "", 7.5)
	drawRightHeaderLine(pdf, pageMarginMM+2*regionWidth, pageMarginMM+1, regionWidth, document.ExportedAt.Format("02.01.2006 15:04"))
	drawRightHeaderLine(pdf, pageMarginMM+2*regionWidth, pageMarginMM+5.5, regionWidth, fmt.Sprintf("Seite %d/%d", pdf.PageNo(), totalPages))

	pdf.SetDrawColor(185, 195, 207)
	pdf.SetLineWidth(0.25)
	pdf.Line(pageMarginMM, dividerY, pageWidthMM-pageMarginMM, dividerY)
}

func documentHeaderPositions(document Document) (float64, float64) {
	if strings.TrimSpace(document.Subtitle) != "" || strings.TrimSpace(document.SubjectName) != "" {
		return detailHeaderDividerY, detailTableHeaderY
	}
	return compactHeaderDividerY, compactTableHeaderY
}

func drawRightHeaderLine(pdf *fpdf.Fpdf, x, y, width float64, value string) {
	pdf.SetXY(x, y)
	pdf.CellFormat(width, 4.2, value, "", 0, "R", false, 0, "")
}

func drawGroupName(pdf *fpdf.Fpdf, name string, x, y, width float64) {
	name = strings.TrimSpace(cleanText(name))
	if name == "" || width < 8 {
		return
	}
	pdf.SetTextColor(brandDarkRed, brandDarkGreen, brandDarkBlue)
	fontSize := 9.0
	var lines []string
	for fontSize >= 6 {
		pdf.SetFont(regularFontFamily, "B", fontSize)
		lines = splitText(pdf, name, width)
		if len(lines) <= 2 {
			break
		}
		fontSize -= 0.5
	}
	if len(lines) > 2 {
		remaining := strings.Join(lines[1:], " ")
		lines = []string{lines[0], truncatePDFText(pdf, remaining, width)}
	}
	lineHeight := 4.2
	startY := y + (12-float64(len(lines))*lineHeight)/2
	for index, line := range lines {
		pdf.SetXY(x, startY+float64(index)*lineHeight)
		pdf.CellFormat(width, lineHeight, line, "", 0, "L", false, 0, "")
	}
}

func truncatePDFText(pdf *fpdf.Fpdf, value string, width float64) string {
	value = strings.TrimSpace(value)
	if pdf.GetStringWidth(value) <= width {
		return value
	}
	runes := []rune(value)
	for len(runes) > 0 && pdf.GetStringWidth(string(runes)+"...") > width {
		runes = runes[:len(runes)-1]
	}
	return strings.TrimSpace(string(runes)) + "..."
}

func drawFallbackMark(pdf *fpdf.Fpdf, x, y float64) {
	const diameter = 12.0
	pdf.SetFillColor(brandRed, brandGreen, brandBlue)
	pdf.Circle(x+diameter/2, y+diameter/2, diameter/2, "F")
	pdf.SetTextColor(255, 255, 255)
	pdf.SetFont(regularFontFamily, "B", 9)
	pdf.SetXY(x, y+3.25)
	pdf.CellFormat(diameter, 4.5, "TT", "", 0, "C", false, 0, "")
}

func drawSubjectIdentity(pdf *fpdf.Fpdf, name string, imageRegistered bool, avatarCenterX, nameX, y, nameWidth float64) {
	name = strings.TrimSpace(cleanText(name))
	if name == "" || nameWidth < 8 {
		return
	}
	const avatarSize = 7.0
	avatarX := avatarCenterX - avatarSize/2
	if imageRegistered {
		info := pdf.GetImageInfo("teamtaler-export-subject")
		if info != nil {
			imageWidth, imageHeight := fitRectangle(info.Width(), info.Height(), avatarSize, avatarSize)
			pdf.ImageOptions("teamtaler-export-subject", avatarX+(avatarSize-imageWidth)/2, y+(avatarSize-imageHeight)/2, imageWidth, imageHeight, false, fpdf.ImageOptions{ImageType: "PNG"}, 0, "")
		}
	} else {
		drawSubjectFallback(pdf, subjectInitials(name), avatarX, y, avatarSize)
	}
	pdf.SetTextColor(brandDarkRed, brandDarkGreen, brandDarkBlue)
	pdf.SetFont(regularFontFamily, "", 7.5)
	pdf.SetXY(nameX, y+1.4)
	pdf.CellFormat(nameWidth, 4.2, truncatePDFText(pdf, name, nameWidth), "", 0, "L", false, 0, "")
}

func drawSubjectFallback(pdf *fpdf.Fpdf, initials string, x, y, size float64) {
	pdf.SetFillColor(230, 244, 242)
	pdf.SetDrawColor(brandRed, brandGreen, brandBlue)
	pdf.SetLineWidth(0.25)
	pdf.Circle(x+size/2, y+size/2, size/2, "FD")
	pdf.SetTextColor(brandRed, brandGreen, brandBlue)
	pdf.SetFont(regularFontFamily, "B", 6.2)
	pdf.SetXY(x, y+1.4)
	pdf.CellFormat(size, 4.2, initials, "", 0, "C", false, 0, "")
}

func subjectInitials(name string) string {
	words := strings.Fields(name)
	if len(words) == 0 {
		return "?"
	}
	initials := []rune(words[0])[:1]
	if len(words) > 1 {
		last := []rune(words[len(words)-1])
		if len(last) > 0 {
			initials = append(initials, last[0])
		}
	}
	return strings.ToUpper(string(initials))
}

func drawCenteredTitle(pdf *fpdf.Fpdf, title string, x, y, width float64) {
	fontSize := 12.0
	var lines []string
	for fontSize >= 7 {
		pdf.SetFont(regularFontFamily, "B", fontSize)
		lines = splitText(pdf, title, width-4)
		if len(lines) <= 2 {
			break
		}
		fontSize -= 0.5
	}
	if len(lines) == 0 {
		lines = []string{""}
	}
	lineHeight := 4.8
	startY := y + (12-float64(len(lines))*lineHeight)/2
	for index, line := range lines {
		pdf.SetXY(x, startY+float64(index)*lineHeight)
		pdf.CellFormat(width, lineHeight, line, "", 0, "C", false, 0, "")
	}
}

func drawCenteredStatementTitle(pdf *fpdf.Fpdf, title, subtitle string, x, y, width float64) {
	pdf.SetTextColor(brandDarkRed, brandDarkGreen, brandDarkBlue)
	pdf.SetFont(regularFontFamily, "B", 11.5)
	title = truncatePDFText(pdf, strings.TrimSpace(cleanText(title)), width-4)
	pdf.SetXY(x, y+2)
	pdf.CellFormat(width, 5, title, "", 0, "C", false, 0, "")
	pdf.SetFont(regularFontFamily, "", 8.5)
	subtitle = truncatePDFText(pdf, strings.TrimSpace(cleanText(subtitle)), width-4)
	pdf.SetXY(x, y+8.2)
	pdf.CellFormat(width, 4.5, subtitle, "", 0, "C", false, 0, "")
}

func drawTableHeader(pdf *fpdf.Fpdf, document Document, band columnBand, tableY float64) float64 {
	pdf.SetFont(regularFontFamily, "B", 8.2)
	lineSets := make([][]string, len(band.indexes))
	maximumLines := 1
	for position, columnIndex := range band.indexes {
		lineSets[position] = splitText(pdf, cleanText(document.Columns[columnIndex].Header), band.widths[position]-2*cellPadding)
		if len(lineSets[position]) > maximumLines {
			maximumLines = len(lineSets[position])
		}
	}
	height := math.Max(8, float64(maximumLines)*3.8+2)
	x := pageMarginMM
	for position, columnIndex := range band.indexes {
		width := band.widths[position]
		pdf.SetFillColor(brandRed, brandGreen, brandBlue)
		pdf.SetDrawColor(255, 255, 255)
		pdf.Rect(x, tableY, width, height, "FD")
		pdf.SetTextColor(255, 255, 255)
		alignment := pdfAlignment(document.Columns[columnIndex])
		for lineIndex, line := range lineSets[position] {
			pdf.SetXY(x+cellPadding, tableY+1+float64(lineIndex)*3.8)
			pdf.CellFormat(width-2*cellPadding, 3.8, line, "", 0, alignment, false, 0, "")
		}
		x += width
	}
	return tableY + height + 1.2
}

func renderWrappedRow(pdf *fpdf.Fpdf, document Document, band columnBand, row Row, rowIndex int, bodyStartY *float64, cellImages cellImageRegistry) {
	pdf.SetFont(regularFontFamily, "", bodyFontSize)
	lineSets := make([][]string, len(band.indexes))
	maximumLines := 1
	minimumHeight := 0.0
	for position, columnIndex := range band.indexes {
		cell := row.Cells[columnIndex]
		textWidth := band.widths[position] - 2*cellPadding
		if cellHasImageSlot(cell, cellImages) {
			textWidth -= cellImageSizeMM + cellImageGapMM
			minimumHeight = decoratedRowMM
		}
		lineSets[position] = splitText(pdf, normalizedLineBreaks(cellDisplay(document.Columns[columnIndex], cell)), textWidth)
		if len(lineSets[position]) > maximumLines {
			maximumLines = len(lineSets[position])
		}
	}

	lineOffset := 0
	for lineOffset < maximumLines {
		y := pdf.GetY()
		if lineOffset == 0 && minimumHeight > 0 && y+minimumHeight > pageBottomY {
			pdf.AddPage()
			y = pdf.GetY()
		}
		fullHeight := math.Max(float64(maximumLines-lineOffset)*bodyLineHeight+2, minimumHeight)
		maximumBodyHeight := pageBottomY - *bodyStartY
		if fullHeight <= maximumBodyHeight && y+fullHeight > pageBottomY {
			pdf.AddPage()
			y = pdf.GetY()
		}
		availableLines := int(math.Floor((pageBottomY - y - 2) / bodyLineHeight))
		if availableLines < 1 {
			pdf.AddPage()
			y = pdf.GetY()
			availableLines = int(math.Floor((pageBottomY - y - 2) / bodyLineHeight))
			if availableLines < 1 {
				pdf.SetError(fmt.Errorf("table header leaves no room for rows"))
				return
			}
		}
		linesInChunk := min(maximumLines-lineOffset, availableLines)
		chunkHeight := float64(linesInChunk)*bodyLineHeight + 2
		if lineOffset == 0 {
			chunkHeight = math.Max(chunkHeight, minimumHeight)
		}
		drawRowChunk(pdf, document, band, row, lineSets, lineOffset, linesInChunk, rowIndex, y, chunkHeight, cellImages)
		pdf.SetXY(pageMarginMM, y+chunkHeight)
		lineOffset += linesInChunk
		if lineOffset < maximumLines {
			pdf.AddPage()
		}
	}
}

func drawRowChunk(pdf *fpdf.Fpdf, document Document, band columnBand, row Row, lineSets [][]string, offset, count, rowIndex int, y, height float64, cellImages cellImageRegistry) {
	x := pageMarginMM
	for position, columnIndex := range band.indexes {
		cell := row.Cells[columnIndex]
		width := band.widths[position]
		if rowIndex%2 == 0 {
			pdf.SetFillColor(248, 250, 252)
		} else {
			pdf.SetFillColor(255, 255, 255)
		}
		pdf.SetDrawColor(214, 220, 228)
		pdf.SetLineWidth(0.15)
		pdf.Rect(x, y, width, height, "FD")
		setCellTone(pdf, cell.Tone)
		if cell.Tone != ToneDefault {
			pdf.SetFont(regularFontFamily, "B", bodyFontSize)
		}
		alignment := pdfAlignment(document.Columns[columnIndex])
		contentX := x + cellPadding
		contentWidth := width - 2*cellPadding
		if offset == 0 {
			if cellHasImageSlot(cell, cellImages) {
				if imageName := cellImageName(cell, cellImages); imageName != "" {
					drawCellImage(pdf, imageName, contentX, y+(height-cellImageSizeMM)/2)
				}
				contentX += cellImageSizeMM + cellImageGapMM
				contentWidth -= cellImageSizeMM + cellImageGapMM
			}
		}
		textY := y + 1
		if offset == 0 {
			textY = y + (height-float64(count)*bodyLineHeight)/2
		}
		for lineIndex := 0; lineIndex < count; lineIndex++ {
			absoluteLine := offset + lineIndex
			line := ""
			if absoluteLine < len(lineSets[position]) {
				line = lineSets[position][absoluteLine]
			}
			pdf.SetXY(contentX, textY+float64(lineIndex)*bodyLineHeight)
			pdf.CellFormat(contentWidth, bodyLineHeight, line, "", 0, alignment, false, 0, "")
		}
		pdf.SetFont(regularFontFamily, "", bodyFontSize)
		x += width
	}
}

func cellImageName(cell Cell, registered cellImageRegistry) string {
	if len(cell.ImagePNG) == 0 {
		return ""
	}
	return registered[sha256.Sum256(cell.ImagePNG)]
}

func cellHasImageSlot(cell Cell, registered cellImageRegistry) bool {
	return cell.ImageSlot || cellImageName(cell, registered) != ""
}

func drawCellImage(pdf *fpdf.Fpdf, name string, x, y float64) {
	info := pdf.GetImageInfo(name)
	if info == nil {
		return
	}
	width, height := fitRectangle(info.Width(), info.Height(), cellImageSizeMM, cellImageSizeMM)
	pdf.ImageOptions(name, x+(cellImageSizeMM-width)/2, y+(cellImageSizeMM-height)/2, width, height, false, fpdf.ImageOptions{ImageType: "PNG"}, 0, "")
}

func setCellTone(pdf *fpdf.Fpdf, tone CellTone) {
	switch tone {
	case ToneWarning:
		pdf.SetTextColor(151, 96, 0)
	case ToneSuccess:
		pdf.SetTextColor(27, 112, 57)
	case ToneInfo:
		pdf.SetTextColor(32, 95, 145)
	case ToneDanger:
		pdf.SetTextColor(180, 35, 45)
	default:
		pdf.SetTextColor(16, 23, 37)
	}
}

func buildColumnBands(pdf *fpdf.Fpdf, document Document) []columnBand {
	widths := preferredColumnWidths(pdf, document)
	total := sumWidths(widths)
	if total <= pageContentWidth {
		return []columnBand{newColumnBand(allColumnIndexes(len(widths)), widths)}
	}

	identityIndexes := make([]int, 0)
	otherIndexes := make([]int, 0)
	for index, column := range document.Columns {
		if column.Identity {
			identityIndexes = append(identityIndexes, index)
		} else {
			otherIndexes = append(otherIndexes, index)
		}
	}
	if len(otherIndexes) == 0 {
		return []columnBand{newColumnBand(identityIndexes, widths)}
	}

	identityWidths := selectedWidths(widths, identityIndexes)
	identityTotal := sumWidths(identityWidths)
	identityLimit := pageContentWidth * 0.45
	if identityTotal > identityLimit && identityTotal > 0 {
		scaleWidths(identityWidths, identityLimit/identityTotal)
		identityTotal = identityLimit
	}

	bands := make([]columnBand, 0)
	remaining := append([]int(nil), otherIndexes...)
	for len(remaining) > 0 {
		indexes := append([]int(nil), identityIndexes...)
		bandWidths := append([]float64(nil), identityWidths...)
		used := identityTotal
		consumed := 0
		for consumed < len(remaining) {
			columnIndex := remaining[consumed]
			width := widths[columnIndex]
			if consumed == 0 && used+width > pageContentWidth {
				width = pageContentWidth - used
			}
			if used+width > pageContentWidth+0.001 {
				break
			}
			indexes = append(indexes, columnIndex)
			bandWidths = append(bandWidths, width)
			used += width
			consumed++
		}
		if consumed == 0 {
			return nil
		}
		remaining = remaining[consumed:]
		sort.SliceStable(indexes, func(left, right int) bool { return indexes[left] < indexes[right] })
		orderedWidths := make([]float64, len(indexes))
		for position, index := range indexes {
			for originalPosition, originalIndex := range append(append([]int(nil), identityIndexes...), otherIndexes...) {
				if originalIndex == index {
					if originalPosition < len(identityIndexes) {
						orderedWidths[position] = identityWidths[originalPosition]
					} else {
						orderedWidths[position] = widths[index]
						if orderedWidths[position] > pageContentWidth-identityTotal {
							orderedWidths[position] = pageContentWidth - identityTotal
						}
					}
					break
				}
			}
		}
		bands = append(bands, newColumnBand(indexes, orderedWidths))
	}
	return bands
}

func preferredColumnWidths(pdf *fpdf.Fpdf, document Document) []float64 {
	pdf.SetFont(regularFontFamily, "", bodyFontSize)
	widths := make([]float64, len(document.Columns))
	for columnIndex, column := range document.Columns {
		if column.WidthMM > 0 {
			widths[columnIndex] = column.WidthMM
			continue
		}
		width := pdf.GetStringWidth(column.Header) + 2*cellPadding + 2
		if column.Kind == MoneyColumn && width < 32 {
			width = 32
		}
		for rowIndex := 0; rowIndex < len(document.Rows) && rowIndex < 50; rowIndex++ {
			valueWidth := pdf.GetStringWidth(cellDisplay(column, document.Rows[rowIndex].Cells[columnIndex])) + 2*cellPadding + 2
			if valueWidth > width {
				width = valueWidth
			}
		}
		widths[columnIndex] = math.Max(minimumColumnMM, math.Min(maximumColumnMM, width))
	}
	return widths
}

func newColumnBand(indexes []int, widths []float64) columnBand {
	band := columnBand{indexes: append([]int(nil), indexes...), widths: append([]float64(nil), widths...)}
	total := sumWidths(band.widths)
	if total > 0 {
		scaleWidths(band.widths, pageContentWidth/total)
	}
	return band
}

func allColumnIndexes(count int) []int {
	indexes := make([]int, count)
	for index := range indexes {
		indexes[index] = index
	}
	return indexes
}

func selectedWidths(widths []float64, indexes []int) []float64 {
	selected := make([]float64, len(indexes))
	for position, index := range indexes {
		selected[position] = widths[index]
	}
	return selected
}

func scaleWidths(widths []float64, factor float64) {
	for index := range widths {
		widths[index] *= factor
	}
}

func sumWidths(widths []float64) float64 {
	total := 0.0
	for _, width := range widths {
		total += width
	}
	return total
}

func splitText(pdf *fpdf.Fpdf, text string, width float64) []string {
	lines := pdf.SplitText(cleanText(text), math.Max(width, 1))
	if len(lines) == 0 {
		return []string{""}
	}
	return lines
}

func pdfAlignment(column Column) string {
	switch column.Alignment {
	case AlignLeft:
		return "L"
	case AlignCenter:
		return "C"
	case AlignRight:
		return "R"
	default:
		if column.Kind == MoneyColumn {
			return "R"
		}
		return "L"
	}
}

func fitRectangle(sourceWidth, sourceHeight, maximumWidth, maximumHeight float64) (float64, float64) {
	if sourceWidth <= 0 || sourceHeight <= 0 {
		return 0, 0
	}
	factor := math.Min(maximumWidth/sourceWidth, maximumHeight/sourceHeight)
	return sourceWidth * factor, sourceHeight * factor
}

func normalizedLineBreaks(value string) string {
	return strings.ReplaceAll(value, "\r", "")
}
