package kiosk

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"
)

func TestPosterPDFPaginatesHundredProducts(t *testing.T) {
	const base = "https://scan-and-go.very-long-community-group-name.teamtaler.example.test/book?group=grp_0123456789abcdef0123456789abcdef"
	products := make([]posterProduct, 100)
	for index := range products {
		products[index] = posterProduct{
			ID:         fmt.Sprintf("prod_%032x", index),
			Name:       fmt.Sprintf("Product number %d with a longer descriptive name", index+1),
			PriceMinor: sql.NullInt64{Int64: int64(125 + index), Valid: true},
			Currency:   "EUR",
		}
	}
	document := posterDocument{
		Poster:     Poster{Name: "Full catalog", Text: "Choose your products, then confirm the booking."},
		GroupName:  "Long Community Name",
		Products:   products,
		BookingURL: base,
	}
	pdf, err := renderPoster(context.Background(), document, t.TempDir())
	if err != nil {
		t.Fatalf("render 100-product PDF: %v", err)
	}
	pagePattern := regexp.MustCompile(`/Type /Page\s`)
	if count := len(pagePattern.FindAll(pdf, -1)); count != 11 {
		t.Fatalf("page count=%d, want 10 product pages plus text page", count)
	}
	if !bytes.HasPrefix(pdf, []byte("%PDF-")) {
		t.Fatal("poster output is not a PDF")
	}
	if output := os.Getenv("TEAMTALER_LONG_POSTER_PDF_TEST_OUTPUT"); output != "" {
		if err := os.WriteFile(output, pdf, 0o600); err != nil {
			t.Fatalf("write long PDF preview: %v", err)
		}
	}
}

func TestPosterPriceUsesCurrencyExponent(t *testing.T) {
	if got := formatPrice(125, "EUR"); got != "1,25 EUR" {
		t.Fatalf("EUR price=%q", got)
	}
	if got := formatPrice(125, "JPY"); got != "125 JPY" {
		t.Fatalf("JPY price=%q", got)
	}
	if got := formatPrice(125, "KWD"); got != "0,125 KWD" {
		t.Fatalf("KWD price=%q", got)
	}
}

func TestGroupOnlyPosterPaginatesLongFreeText(t *testing.T) {
	document := posterDocument{
		Poster:     Poster{Name: "Information", Text: strings.Repeat("Please confirm every booking before leaving the kiosk. ", 35)},
		GroupName:  "Community Group",
		BookingURL: "https://teamtaler.example.test/book?group=grp_0123456789abcdef0123456789abcdef",
	}
	pdf, err := renderPoster(context.Background(), document, t.TempDir())
	if err != nil {
		t.Fatalf("render long free text: %v", err)
	}
	pagePattern := regexp.MustCompile(`/Type /Page\s`)
	if count := len(pagePattern.FindAll(pdf, -1)); count < 2 {
		t.Fatalf("long free text page count=%d, want at least 2", count)
	}
}
