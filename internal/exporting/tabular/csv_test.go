package tabular

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
)

func TestWriteCSVUsesGermanSpreadsheetDialectAndFormulaProtection(t *testing.T) {
	document := basicFixtureDocument()
	document.Columns = append(document.Columns,
		Column{ID: "note", Header: "Notiz", Kind: TextColumn},
		Column{ID: "formula", Header: "Eingabe", Kind: TextColumn},
	)
	document.Rows[0].Cells = append(document.Rows[0].Cells,
		Cell{Text: "Zeile 1\nZeile 2; mit Semikolon und \"Zitat\""},
		Cell{Text: "  =HYPERLINK(\"https://invalid.example\")"},
	)
	var output bytes.Buffer
	if err := WriteCSV(&output, document); err != nil {
		t.Fatalf("WriteCSV() error = %v", err)
	}

	want := "\xEF\xBB\xBFMitglied;Betrag;Notiz;Eingabe\r\n" +
		"Jörg Müller;-12,50 EUR;\"Zeile 1\r\nZeile 2; mit Semikolon und \"\"Zitat\"\"\";\"'  =HYPERLINK(\"\"https://invalid.example\"\")\"\r\n"
	if got := output.String(); got != want {
		t.Fatalf("CSV output:\n%q\nwant:\n%q", got, want)
	}
}

func TestProtectSpreadsheetFormulaRecognizesDangerousPrefixes(t *testing.T) {
	for _, value := range []string{"=1+1", "+cmd", "-2+3", "@SUM(A1:A2)", "\t=1", "  =1"} {
		if got := protectSpreadsheetFormula(value); got != "'"+value {
			t.Errorf("protectSpreadsheetFormula(%q) = %q", value, got)
		}
	}
	for _, value := range []string{"42", "text", "'literal"} {
		if got := protectSpreadsheetFormula(value); got != value {
			t.Errorf("protectSpreadsheetFormula(%q) = %q, want unchanged", value, got)
		}
	}
}

func TestWriteCSVRejectsInvalidDocumentBeforeWriting(t *testing.T) {
	document := basicFixtureDocument()
	document.Title = ""
	var output bytes.Buffer
	err := WriteCSV(&output, document)
	if err == nil || !strings.Contains(err.Error(), "validate CSV document") {
		t.Fatalf("WriteCSV() error = %v", err)
	}
	if output.Len() != 0 {
		t.Fatalf("WriteCSV() wrote %d bytes for invalid input", output.Len())
	}
}

func TestWriteCSVPropagatesWriterFailure(t *testing.T) {
	err := WriteCSV(failingWriter{}, basicFixtureDocument())
	if !errors.Is(err, errFixtureWrite) {
		t.Fatalf("WriteCSV() error = %v, want fixture write error", err)
	}
}

func TestWriteCSVContextStopsBeforeWritingWhenCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var output bytes.Buffer
	if err := WriteCSVContext(ctx, &output, basicFixtureDocument()); !errors.Is(err, context.Canceled) {
		t.Fatalf("WriteCSVContext() error = %v, want context cancellation", err)
	}
	if output.Len() != 0 {
		t.Fatalf("WriteCSVContext() wrote %d bytes after cancellation", output.Len())
	}
}

var errFixtureWrite = errors.New("fixture write failed")

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) {
	return 0, errFixtureWrite
}
