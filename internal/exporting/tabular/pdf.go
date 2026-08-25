package tabular

import (
	"bytes"
	"context"
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
	pageWidthMM      = 297.0
	pageHeightMM     = 210.0
	pageMarginMM     = 10.0
	pageContentWidth = pageWidthMM - 2*pageMarginMM
	headerDividerY   = 28.0
	tableHeaderY     = 31.0
	pageBottomY      = pageHeightMM - pageMarginMM
	bodyFontSize     = 8.0
	bodyLineHeight   = 4.1
	cellPadding      = 1.3
	minimumColumnMM  = 20.0
	maximumColumnMM  = 75.0
	brandRed         = 0
	brandGreen       = 124
	brandBlue        = 115
	brandDarkRed     = 6
	brandDarkGreen   = 21
	brandDarkBlue    = 45

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

// WritePDF validates document and writes a deterministic, Unicode-capable A4
// landscape PDF to output. Every page has the group logo or TeamTaler fallback
// mark, centered title, localized export timestamp, page n/m, and a repeated
// table header. Wide tables use horizontal bands with identity columns repeated;
// tall rows wrap and continue without clipping.
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

	pdf := fpdf.NewCustom(&fpdf.InitType{
		OrientationStr: "L",
		UnitStr:        "mm",
		SizeStr:        "A4",
	})
	pdf.AliasNbPages("")
	pdf.AddUTF8FontFromBytes(regularFontFamily, "", notoSansRegular)
	pdf.AddUTF8FontFromBytes(regularFontFamily, "B", notoSansSemibold)
	pdf.SetCatalogSort(true)
	pdf.SetCompression(true)
	pdf.SetMargins(pageMarginMM, pageMarginMM, pageMarginMM)
	pdf.SetAutoPageBreak(false, pageMarginMM)
	pdf.SetCreationDate(document.ExportedAt)
	pdf.SetModificationDate(document.ExportedAt)
	pdf.SetTitle(document.Title, true)
	pdf.SetSubject("TeamTaler table export", true)
	pdf.SetAuthor("TeamTaler", true)
	pdf.SetCreator("TeamTaler", true)
	pdf.SetLang("de-DE")

	logoRegistered := registerLogo(pdf, document.LogoPNG)
	pdf.SetFont(regularFontFamily, "", bodyFontSize)
	bands := buildColumnBands(pdf, document)
	if len(bands) == 0 {
		return fmt.Errorf("calculate PDF column layout: no column bands")
	}

	currentBand := bands[0]
	bodyStartY := tableHeaderY
	pdf.SetHeaderFuncMode(func() {
		drawDocumentHeader(pdf, document, logoRegistered)
		bodyStartY = drawTableHeader(pdf, document, currentBand)
		pdf.SetXY(pageMarginMM, bodyStartY)
	}, false)

	for _, band := range bands {
		if err := ctx.Err(); err != nil {
			return err
		}
		currentBand = band
		pdf.AddPage()
		if err := pdf.Error(); err != nil {
			return fmt.Errorf("start PDF page: %w", err)
		}
		if len(document.Rows) == 0 {
			continue
		}
		for rowIndex, row := range document.Rows {
			if err := ctx.Err(); err != nil {
				return err
			}
			renderWrappedRow(pdf, document, band, row, rowIndex, &bodyStartY)
			if err := pdf.Error(); err != nil {
				return fmt.Errorf("render PDF row %d: %w", rowIndex, err)
			}
		}
	}
	if err := pdf.Output(contextWriter{context: ctx, writer: output}); err != nil {
		return fmt.Errorf("write PDF: %w", err)
	}
	return nil
}

func registerLogo(pdf *fpdf.Fpdf, source []byte) bool {
	logo, ok := normalizeLogo(source)
	if !ok {
		return false
	}
	pdf.RegisterImageOptionsReader("teamtaler-export-logo", fpdf.ImageOptions{ImageType: "PNG"}, bytes.NewReader(logo))
	return pdf.Error() == nil
}

func normalizeLogo(source []byte) ([]byte, bool) {
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

func drawDocumentHeader(pdf *fpdf.Fpdf, document Document, logoRegistered bool) {
	regionWidth := pageContentWidth / 3
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
		}
	} else {
		drawFallbackMark(pdf, pageMarginMM, pageMarginMM)
	}

	pdf.SetTextColor(brandDarkRed, brandDarkGreen, brandDarkBlue)
	drawCenteredTitle(pdf, document.Title, pageMarginMM+regionWidth, pageMarginMM, regionWidth)

	pdf.SetFont(regularFontFamily, "", 7.5)
	pdf.SetXY(pageMarginMM+2*regionWidth, pageMarginMM+1)
	pdf.CellFormat(regionWidth, 4.2, "Exportiert: "+document.ExportedAt.Format("02.01.2006 15:04 MST"), "", 0, "R", false, 0, "")
	pdf.SetXY(pageMarginMM+2*regionWidth, pageMarginMM+5.5)
	pdf.CellFormat(regionWidth, 4.2, fmt.Sprintf("Seite %d/{nb}", pdf.PageNo()), "", 0, "R", false, 0, "")

	pdf.SetDrawColor(185, 195, 207)
	pdf.SetLineWidth(0.25)
	pdf.Line(pageMarginMM, headerDividerY, pageWidthMM-pageMarginMM, headerDividerY)
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

func drawTableHeader(pdf *fpdf.Fpdf, document Document, band columnBand) float64 {
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
		pdf.Rect(x, tableHeaderY, width, height, "FD")
		pdf.SetTextColor(255, 255, 255)
		alignment := pdfAlignment(document.Columns[columnIndex])
		for lineIndex, line := range lineSets[position] {
			pdf.SetXY(x+cellPadding, tableHeaderY+1+float64(lineIndex)*3.8)
			pdf.CellFormat(width-2*cellPadding, 3.8, line, "", 0, alignment, false, 0, "")
		}
		x += width
	}
	return tableHeaderY + height + 1.2
}

func renderWrappedRow(pdf *fpdf.Fpdf, document Document, band columnBand, row Row, rowIndex int, bodyStartY *float64) {
	pdf.SetFont(regularFontFamily, "", bodyFontSize)
	lineSets := make([][]string, len(band.indexes))
	maximumLines := 1
	for position, columnIndex := range band.indexes {
		lineSets[position] = splitText(pdf, normalizedLineBreaks(cellDisplay(document.Columns[columnIndex], row.Cells[columnIndex])), band.widths[position]-2*cellPadding)
		if len(lineSets[position]) > maximumLines {
			maximumLines = len(lineSets[position])
		}
	}

	lineOffset := 0
	for lineOffset < maximumLines {
		y := pdf.GetY()
		fullHeight := float64(maximumLines-lineOffset)*bodyLineHeight + 2
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
		drawRowChunk(pdf, document, band, lineSets, lineOffset, linesInChunk, rowIndex, y, chunkHeight)
		pdf.SetXY(pageMarginMM, y+chunkHeight)
		lineOffset += linesInChunk
		if lineOffset < maximumLines {
			pdf.AddPage()
		}
	}
}

func drawRowChunk(pdf *fpdf.Fpdf, document Document, band columnBand, lineSets [][]string, offset, count, rowIndex int, y, height float64) {
	x := pageMarginMM
	for position, columnIndex := range band.indexes {
		width := band.widths[position]
		if rowIndex%2 == 0 {
			pdf.SetFillColor(248, 250, 252)
		} else {
			pdf.SetFillColor(255, 255, 255)
		}
		pdf.SetDrawColor(214, 220, 228)
		pdf.SetLineWidth(0.15)
		pdf.Rect(x, y, width, height, "FD")
		pdf.SetTextColor(16, 23, 37)
		alignment := pdfAlignment(document.Columns[columnIndex])
		for lineIndex := 0; lineIndex < count; lineIndex++ {
			absoluteLine := offset + lineIndex
			line := ""
			if absoluteLine < len(lineSets[position]) {
				line = lineSets[position][absoluteLine]
			}
			pdf.SetXY(x+cellPadding, y+1+float64(lineIndex)*bodyLineHeight)
			pdf.CellFormat(width-2*cellPadding, bodyLineHeight, line, "", 0, alignment, false, 0, "")
		}
		x += width
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
