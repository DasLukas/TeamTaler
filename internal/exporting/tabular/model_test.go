package tabular

import (
	"strings"
	"testing"
	"time"
)

func TestDocumentValidateAcceptsTypedRows(t *testing.T) {
	document := basicFixtureDocument()
	if err := document.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestDocumentValidateRejectsMalformedData(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Document)
		match  string
	}{
		{name: "empty title", mutate: func(document *Document) { document.Title = " " }, match: "title"},
		{name: "long group name", mutate: func(document *Document) { document.GroupName = strings.Repeat("a", maxGroupNameRunes+1) }, match: "group name"},
		{name: "missing timestamp", mutate: func(document *Document) { document.ExportedAt = time.Time{} }, match: "timestamp"},
		{name: "invalid column ID", mutate: func(document *Document) { document.Columns[0].ID = "Member Name" }, match: "invalid ID"},
		{name: "duplicate column ID", mutate: func(document *Document) { document.Columns[1].ID = document.Columns[0].ID }, match: "duplicated"},
		{name: "missing cell", mutate: func(document *Document) { document.Rows[0].Cells = document.Rows[0].Cells[:1] }, match: "contains 1 cells"},
		{name: "money in text", mutate: func(document *Document) {
			document.Rows[0].Cells[0].Money = &Money{MinorUnits: "1", Currency: "EUR", DecimalPlaces: 2}
		}, match: "money in a text"},
		{name: "text in money", mutate: func(document *Document) { document.Rows[0].Cells[1].Text = "1,00 EUR" }, match: "text in a money"},
		{name: "image in money", mutate: func(document *Document) { document.Rows[0].Cells[1].ImagePNG = []byte("image") }, match: "decorates a money"},
		{name: "image slot in money", mutate: func(document *Document) { document.Rows[0].Cells[1].ImageSlot = true }, match: "decorates a money"},
		{name: "unsupported tone", mutate: func(document *Document) { document.Rows[0].Cells[0].Tone = CellTone(99) }, match: "unsupported tone"},
		{name: "oversized cell image", mutate: func(document *Document) { document.Rows[0].Cells[0].ImagePNG = make([]byte, maxCellImageBytes+1) }, match: "image exceeds"},
		{name: "invalid currency", mutate: func(document *Document) { document.Rows[0].Cells[1].Money.Currency = "euro" }, match: "currency"},
		{name: "noncanonical units", mutate: func(document *Document) { document.Rows[0].Cells[1].Money.MinorUnits = "01" }, match: "canonical"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			document := basicFixtureDocument()
			test.mutate(&document)
			err := document.Validate()
			if err == nil || !strings.Contains(err.Error(), test.match) {
				t.Fatalf("Validate() error = %v, want substring %q", err, test.match)
			}
		})
	}
}

func TestFormatMoneyUsesExactMinorUnits(t *testing.T) {
	tests := []struct {
		money Money
		want  string
	}{
		{money: Money{MinorUnits: "0", Currency: "EUR", DecimalPlaces: 2}, want: "0,00 EUR"},
		{money: Money{MinorUnits: "-1250", Currency: "EUR", DecimalPlaces: 2}, want: "-12,50 EUR"},
		{money: Money{MinorUnits: "123", Currency: "JPY", DecimalPlaces: 0}, want: "123 JPY"},
		{money: Money{MinorUnits: "1234", Currency: "KWD", DecimalPlaces: 3}, want: "1,234 KWD"},
		{money: Money{MinorUnits: "900719925474099312345", Currency: "EUR", DecimalPlaces: 2}, want: "9.007.199.254.740.993.123,45 EUR"},
	}
	for _, test := range tests {
		if got := formatMoney(test.money); got != test.want {
			t.Errorf("formatMoney(%+v) = %q, want %q", test.money, got, test.want)
		}
	}
}

func basicFixtureDocument() Document {
	return Document{
		Title:      "Aktivitäten",
		GroupName:  "Testgruppe Süd",
		ExportedAt: time.Date(2026, time.August, 25, 14, 32, 10, 0, time.FixedZone("CEST", 2*60*60)),
		Columns: []Column{
			{ID: "member", Header: "Mitglied", Kind: TextColumn, Identity: true},
			{ID: "amount", Header: "Betrag", Kind: MoneyColumn},
		},
		Rows: []Row{{Cells: []Cell{
			{Text: "Jörg Müller"},
			{Money: &Money{MinorUnits: "-1250", Currency: "EUR", DecimalPlaces: 2}},
		}}},
	}
}
