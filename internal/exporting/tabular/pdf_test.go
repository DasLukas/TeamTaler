package tabular

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/go-pdf/fpdf"
)

var pageObjectPattern = regexp.MustCompile(`/Type /Page\s`)

func TestWritePDFIsDeterministicUnicodeLandscapeDocument(t *testing.T) {
	document := pdfFixtureDocument(90, true)
	first := renderPDFForTest(t, document)
	second := renderPDFForTest(t, document)
	if !bytes.Equal(first, second) {
		t.Fatal("WritePDF() produced nondeterministic bytes for identical input")
	}
	if !bytes.HasPrefix(first, []byte("%PDF-")) {
		t.Fatalf("WritePDF() prefix = %q", first[:min(len(first), 8)])
	}
	if !bytes.Contains(first, []byte("/MediaBox [0 0 841.89 595.28]")) {
		t.Fatal("WritePDF() did not create A4 landscape pages")
	}
	if pages := len(pageObjectPattern.FindAll(first, -1)); pages < 3 {
		t.Fatalf("WritePDF() pages = %d, want pagination and horizontal bands", pages)
	}
}

func TestRenderPDFPageCountMatchesOutput(t *testing.T) {
	document := pdfFixtureDocument(120, true)
	countingPDF := newPDFDocument(document)
	counted, err := renderPDFPages(context.Background(), countingPDF, document, 0)
	if err != nil {
		t.Fatalf("count PDF pages: %v", err)
	}
	if counted < 3 {
		t.Fatalf("counted pages = %d, want a multi-page fixture", counted)
	}
	finalPDF := newPDFDocument(document)
	if _, err := renderPDFPages(context.Background(), finalPDF, document, counted); err != nil {
		t.Fatalf("render counted PDF: %v", err)
	}
	var output bytes.Buffer
	if err := finalPDF.Output(&output); err != nil {
		t.Fatalf("write counted PDF: %v", err)
	}
	actual := len(pageObjectPattern.FindAll(output.Bytes(), -1))
	if counted != actual {
		t.Fatalf("counted pages = %d, output pages = %d", counted, actual)
	}
}

func TestWritePDFFallsBackForDamagedLogo(t *testing.T) {
	document := basicFixtureDocument()
	document.LogoPNG = []byte("not a PNG")
	output := renderPDFForTest(t, document)
	if pages := len(pageObjectPattern.FindAll(output, -1)); pages != 1 {
		t.Fatalf("WritePDF() pages = %d, want 1", pages)
	}
}

func TestWritePDFFallsBackForOversizedLogo(t *testing.T) {
	document := basicFixtureDocument()
	document.LogoPNG = make([]byte, maxLogoBytes+1)
	output := renderPDFForTest(t, document)
	if pages := len(pageObjectPattern.FindAll(output, -1)); pages != 1 {
		t.Fatalf("WritePDF() pages = %d, want 1", pages)
	}
}

func TestWritePDFAcceptsNormalizedGroupLogo(t *testing.T) {
	document := basicFixtureDocument()
	document.LogoPNG = fixtureLogoPNG(t)
	output := renderPDFForTest(t, document)
	if !bytes.Contains(output, []byte("/Subtype /Image")) {
		t.Fatal("WritePDF() did not embed the group logo")
	}
}

func TestPDFExportTitleUsesISODatePrefix(t *testing.T) {
	document := basicFixtureDocument()
	if got, want := pdfExportTitle(document), "2026-08-25_Aktivitäten"; got != want {
		t.Fatalf("pdfExportTitle() = %q, want %q", got, want)
	}
}

func TestWritePDFEmbedsCellImagesAndActivityTones(t *testing.T) {
	document := basicFixtureDocument()
	document.Rows[0].Cells[0].ImagePNG = fixtureImagePNG()
	document.Rows[0].Cells[0].Tone = ToneSuccess
	output := renderPDFForTest(t, document)
	if !bytes.Contains(output, []byte("/Subtype /Image")) {
		t.Fatal("WritePDF() did not embed the cell image")
	}
}

func TestBuildColumnBandsRepeatsIdentityColumns(t *testing.T) {
	document := pdfFixtureDocument(1, true)
	pdf := newTestPDF()
	bands := buildColumnBands(pdf, document)
	if len(bands) < 2 {
		t.Fatalf("buildColumnBands() returned %d band, want multiple", len(bands))
	}
	for index, band := range bands {
		if len(band.indexes) == 0 || band.indexes[0] != 0 {
			t.Errorf("band %d indexes = %v, want identity column 0", index, band.indexes)
		}
		if difference := pageContentWidth - sumWidths(band.widths); difference < -0.01 || difference > 0.01 {
			t.Errorf("band %d width = %.3f, want %.3f", index, sumWidths(band.widths), pageContentWidth)
		}
	}
}

func TestWritePDFRejectsInvalidDocumentBeforeWriting(t *testing.T) {
	document := basicFixtureDocument()
	document.ExportedAt = document.ExportedAt.AddDate(0, 0, 0)
	document.Columns[1].Kind = ColumnKind(99)
	var output bytes.Buffer
	err := WritePDF(&output, document)
	if err == nil {
		t.Fatal("WritePDF() error = nil, want validation error")
	}
	if output.Len() != 0 {
		t.Fatalf("WritePDF() wrote %d bytes for invalid input", output.Len())
	}
}

func TestWritePDFContextStopsBeforeWritingWhenCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var output bytes.Buffer
	if err := WritePDFContext(ctx, &output, basicFixtureDocument()); !errors.Is(err, context.Canceled) {
		t.Fatalf("WritePDFContext() error = %v, want context cancellation", err)
	}
	if output.Len() != 0 {
		t.Fatalf("WritePDFContext() wrote %d bytes after cancellation", output.Len())
	}
}

func TestWritePDFVisualFixture(t *testing.T) {
	path := os.Getenv("TEAMTALER_PDF_FIXTURE")
	if path == "" {
		t.Skip("set TEAMTALER_PDF_FIXTURE to write the visual QA fixture")
	}
	file, err := os.OpenFile(filepath.Clean(path), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("create PDF fixture: %v", err)
	}
	if err := WritePDF(file, pdfFixtureDocument(120, true)); err != nil {
		file.Close()
		t.Fatalf("write PDF fixture: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close PDF fixture: %v", err)
	}
}

func TestWritePDFBalanceVisualFixture(t *testing.T) {
	path := os.Getenv("TEAMTALER_BALANCE_PDF_FIXTURE")
	if path == "" {
		t.Skip("set TEAMTALER_BALANCE_PDF_FIXTURE to write the balance visual QA fixture")
	}
	document := basicFixtureDocument()
	document.Title = "Kontostände"
	document.Columns = []Column{
		{ID: "member", Header: "Mitglied", Kind: TextColumn, WidthMM: 90, Identity: true},
		{ID: "membership", Header: "Mitgliedschaft", Kind: TextColumn, WidthMM: 60},
		{ID: "state", Header: "Saldostand", Kind: TextColumn, WidthMM: 60},
		{ID: "balance", Header: "Saldo", Kind: MoneyColumn, Alignment: AlignRight, WidthMM: 60},
	}
	document.Rows = []Row{
		{Cells: []Cell{{Text: "Anna Offen", ImagePNG: fixtureImagePNG(), ImageSlot: true}, {Text: "Aktiv", Tone: ToneSuccess}, {Text: "Offen", Tone: ToneDanger}, {Money: &Money{MinorUnits: "1250", Currency: "EUR", DecimalPlaces: 2}, Tone: ToneDanger}}},
		{Cells: []Cell{{Text: "Ben Ausgeglichen", ImageSlot: true}, {Text: "Aktiv", Tone: ToneSuccess}, {Text: "Ausgeglichen", Tone: ToneSuccess}, {Money: &Money{MinorUnits: "0", Currency: "EUR", DecimalPlaces: 2}, Tone: ToneSuccess}}},
		{Cells: []Cell{{Text: "Carla Guthaben", ImagePNG: fixtureImagePNG(), ImageSlot: true}, {Text: "Aktiv", Tone: ToneSuccess}, {Text: "Guthaben", Tone: ToneSuccess}, {Money: &Money{MinorUnits: "-800", Currency: "EUR", DecimalPlaces: 2}, Tone: ToneSuccess}}},
	}
	file, err := os.OpenFile(filepath.Clean(path), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("create balance PDF fixture: %v", err)
	}
	if err := WritePDF(file, document); err != nil {
		file.Close()
		t.Fatalf("write balance PDF fixture: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close balance PDF fixture: %v", err)
	}
}

func TestWritePDFSettlementVisualFixture(t *testing.T) {
	path := os.Getenv("TEAMTALER_SETTLEMENT_PDF_FIXTURE")
	if path == "" {
		t.Skip("set TEAMTALER_SETTLEMENT_PDF_FIXTURE to write the settlement visual QA fixture")
	}
	document := basicFixtureDocument()
	document.Title = "Abgeschlossene Abrechnungen"
	document.Columns = []Column{
		{ID: "period", Header: "Zeitraum", Kind: TextColumn, WidthMM: 42},
		{ID: "member", Header: "Mitglied", Kind: TextColumn, WidthMM: 50, Identity: true},
		{ID: "membership", Header: "Mitgliedschaft", Kind: TextColumn, WidthMM: 36},
		{ID: "due_at", Header: "Fällig", Kind: TextColumn, WidthMM: 28},
		{ID: "amount", Header: "Forderung", Kind: MoneyColumn, Alignment: AlignRight, WidthMM: 32},
		{ID: "paid", Header: "Bezahlt", Kind: MoneyColumn, Alignment: AlignRight, WidthMM: 32},
		{ID: "status", Header: "Status", Kind: TextColumn, WidthMM: 28},
	}
	document.Rows = []Row{
		{Cells: []Cell{{Text: "August 2026"}, {Text: "Anna Offen", ImagePNG: fixtureImagePNG(), ImageSlot: true}, {Text: "Aktiv", Tone: ToneSuccess}, {Text: "10.09.2026"}, {Money: &Money{MinorUnits: "1250", Currency: "EUR", DecimalPlaces: 2}, Tone: ToneDanger}, {Money: &Money{MinorUnits: "0", Currency: "EUR", DecimalPlaces: 2}, Tone: ToneSuccess}, {Text: "Offen", Tone: ToneDanger}}},
		{Cells: []Cell{{Text: "September 2026"}, {Text: "Ben Nullsaldo", ImageSlot: true}, {Text: "Ehemalig", Tone: ToneWarning}, {Text: "10.10.2026"}, {Money: &Money{MinorUnits: "0", Currency: "EUR", DecimalPlaces: 2}, Tone: ToneSuccess}, {Money: &Money{MinorUnits: "0", Currency: "EUR", DecimalPlaces: 2}, Tone: ToneSuccess}, {Text: "Bezahlt", Tone: ToneSuccess}}},
		{Cells: []Cell{{Text: "Oktober 2026"}, {Text: "Carla Bezahlt", ImagePNG: fixtureImagePNG(), ImageSlot: true}, {Text: "Aktiv", Tone: ToneSuccess}, {Text: "10.11.2026"}, {Money: &Money{MinorUnits: "2000", Currency: "EUR", DecimalPlaces: 2}, Tone: ToneDanger}, {Money: &Money{MinorUnits: "2000", Currency: "EUR", DecimalPlaces: 2}, Tone: ToneSuccess}, {Text: "Bezahlt", Tone: ToneSuccess}}},
	}
	file, err := os.OpenFile(filepath.Clean(path), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("create settlement PDF fixture: %v", err)
	}
	if err := WritePDF(file, document); err != nil {
		file.Close()
		t.Fatalf("write settlement PDF fixture: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close settlement PDF fixture: %v", err)
	}
}

func renderPDFForTest(t *testing.T, document Document) []byte {
	t.Helper()
	var output bytes.Buffer
	if err := WritePDF(&output, document); err != nil {
		t.Fatalf("WritePDF() error = %v", err)
	}
	return output.Bytes()
}

func newTestPDF() *fpdf.Fpdf {
	pdf := fpdf.NewCustom(&fpdf.InitType{OrientationStr: "L", UnitStr: "mm", SizeStr: "A4"})
	pdf.AliasNbPages("")
	pdf.AddUTF8FontFromBytes(regularFontFamily, "", notoSansRegular)
	pdf.SetFont(regularFontFamily, "", bodyFontSize)
	return pdf
}

func pdfFixtureDocument(rowCount int, wide bool) Document {
	document := basicFixtureDocument()
	document.Title = "Aktivitäten - vollständige gefilterte Ansicht"
	document.LogoPNG = nil
	document.Columns = []Column{
		{ID: "member", Header: "Mitglied", Kind: TextColumn, WidthMM: 38, Identity: true},
		{ID: "activity", Header: "Aktivität", Kind: TextColumn, WidthMM: 62},
		{ID: "description", Header: "Beschreibung", Kind: TextColumn, WidthMM: 72},
		{ID: "amount", Header: "Betrag", Kind: MoneyColumn, WidthMM: 38},
	}
	if wide {
		document.Columns = append(document.Columns,
			Column{ID: "category", Header: "Kategorie", Kind: TextColumn, WidthMM: 52},
			Column{ID: "payment_method", Header: "Zahlungsmethode", Kind: TextColumn, WidthMM: 52},
			Column{ID: "created_at", Header: "Erstellt am", Kind: TextColumn, WidthMM: 42},
		)
	}
	document.Rows = make([]Row, rowCount)
	for index := 0; index < rowCount; index++ {
		tone := ToneWarning
		activity := "Buchung"
		if index%3 == 1 {
			tone = ToneSuccess
			activity = "Einzahlung"
		} else if index%3 == 2 {
			tone = ToneInfo
			activity = "Korrektur"
		}
		memberImage := []byte(nil)
		productImage := []byte(nil)
		if index%2 == 0 {
			memberImage = fixtureImagePNG()
		}
		if index%3 != 2 {
			productImage = fixtureImagePNG()
		}
		cells := []Cell{
			{Text: fmt.Sprintf("Jörg Müller %03d", index+1), ImagePNG: memberImage, ImageSlot: true},
			{Text: activity, Tone: tone},
			{Text: "Mehrzeiliger Inhalt mit Umlauten: Äpfel, Öl und Grüße. Eine längere Beschreibung prüft den sauberen Zeilenumbruch ohne Abschneiden.", ImagePNG: productImage, ImageSlot: true},
			{Money: &Money{MinorUnits: fmt.Sprintf("%d", 1250+index), Currency: "EUR", DecimalPlaces: 2}, Tone: tone},
		}
		if wide {
			cells = append(cells,
				Cell{Text: "Vereinsheim"},
				Cell{Text: "Überweisung"},
				Cell{Text: "25.08.2026 14:32 CEST"},
			)
		}
		document.Rows[index] = Row{Cells: cells}
	}
	return document
}

func fixtureLogoPNG(t *testing.T) []byte {
	t.Helper()
	return fixtureImagePNG()
}

func fixtureImagePNG() []byte {
	canvas := image.NewRGBA(image.Rect(0, 0, 72, 72))
	for y := 0; y < 72; y++ {
		for x := 0; x < 72; x++ {
			pixel := color.RGBA{R: 0, G: 124, B: 115, A: 255}
			if (x-36)*(x-36)+(y-27)*(y-27) < 13*13 || (x > 18 && x < 54 && y > 42 && y < 67) {
				pixel = color.RGBA{R: 255, G: 204, B: 77, A: 255}
			}
			canvas.SetRGBA(x, y, pixel)
		}
	}
	var encoded bytes.Buffer
	_ = png.Encode(&encoded, canvas)
	return encoded.Bytes()
}
