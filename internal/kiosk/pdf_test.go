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
	if count := len(pagePattern.FindAll(pdf, -1)); count != 10 {
		t.Fatalf("page count=%d, want 10 complete product pages", count)
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

func TestPosterPDFShortSelectionAndNoteFitOnePage(t *testing.T) {
	products := make([]posterProduct, 4)
	for index := range products {
		products[index] = posterProduct{
			ID:         fmt.Sprintf("product_%d", index),
			Name:       fmt.Sprintf("Product %d with a longer name", index+1),
			PriceMinor: sql.NullInt64{Int64: 150, Valid: true},
			Currency:   "EUR",
		}
	}
	document := posterDocument{
		Poster:     Poster{Name: "Drinks", Text: "Please confirm each booking before leaving."},
		GroupName:  "Community Group",
		Products:   products,
		BookingURL: "https://teamtaler.example.test/book?group=example",
	}
	pdf, err := renderPoster(context.Background(), document, t.TempDir())
	if err != nil {
		t.Fatalf("render four-product PDF: %v", err)
	}
	pagePattern := regexp.MustCompile(`/Type /Page\s`)
	if count := len(pagePattern.FindAll(pdf, -1)); count != 1 {
		t.Fatalf("page count=%d, want one page with products and note", count)
	}
	if output := os.Getenv("TEAMTALER_SHORT_POSTER_PDF_TEST_OUTPUT"); output != "" {
		if err := os.WriteFile(output, pdf, 0o600); err != nil {
			t.Fatalf("write short PDF preview: %v", err)
		}
	}
}

func TestPosterNoteMovesToFollowingPageWhenGridIsFull(t *testing.T) {
	products := make([]posterProduct, 10)
	for index := range products {
		products[index] = posterProduct{
			ID:         fmt.Sprintf("product_%d", index),
			Name:       fmt.Sprintf("Product %d", index+1),
			PriceMinor: sql.NullInt64{Int64: 150, Valid: true},
			Currency:   "EUR",
		}
	}
	document := posterDocument{
		Poster:     Poster{Name: "Full grid", Text: strings.Repeat("Please confirm each booking before leaving. ", 10)},
		GroupName:  "Community Group",
		Products:   products,
		BookingURL: "https://teamtaler.example.test/book?group=example",
	}
	pdf, err := renderPoster(context.Background(), document, t.TempDir())
	if err != nil {
		t.Fatalf("render full-grid PDF: %v", err)
	}
	pagePattern := regexp.MustCompile(`/Type /Page\s`)
	if count := len(pagePattern.FindAll(pdf, -1)); count != 2 {
		t.Fatalf("page count=%d, want a separate page for the note", count)
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
	if output := os.Getenv("TEAMTALER_BOOKING_POSTER_PDF_TEST_OUTPUT"); output != "" {
		if err := os.WriteFile(output, pdf, 0o600); err != nil {
			t.Fatalf("write booking PDF preview: %v", err)
		}
	}
}
