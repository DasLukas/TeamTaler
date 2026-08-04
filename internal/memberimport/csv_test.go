package memberimport

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
)

func TestParseCSVSupportsCommonDelimitersAndBOM(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		document string
	}{
		{name: "comma", document: "email,display_name\nADA@Example.test,Ada Lovelace\n"},
		{name: "semicolon and BOM", document: "\ufeffdisplay_name;email\nAda Lovelace;ADA@Example.test\n"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			rows, err := ParseCSV([]byte(test.document))
			if err != nil {
				t.Fatalf("ParseCSV: %v", err)
			}
			if len(rows) != 1 || rows[0].Email != "ada@example.test" || rows[0].DisplayName != "Ada Lovelace" || rows[0].ValidationCode != "" {
				t.Fatalf("rows = %#v", rows)
			}
		})
	}
}

func TestParseCSVReportsRowErrorsWithoutRejectingDocument(t *testing.T) {
	t.Parallel()

	rows, err := ParseCSV([]byte("email,display_name\ninvalid,Ada\nvalid@example.test," + strings.Repeat("x", 121) + "\nVALID@example.test,Duplicate\nvalid@example.test,Duplicate Again\ncontrol@example.test,\"Line\nBreak\"\n"))
	if err != nil {
		t.Fatalf("ParseCSV: %v", err)
	}
	if len(rows) != 5 {
		t.Fatalf("row count = %d, want 5", len(rows))
	}
	for _, index := range []int{0, 1, 3, 4} {
		if rows[index].ValidationCode == "" {
			t.Fatalf("row %d unexpectedly valid: %#v", index, rows[index])
		}
	}
	if rows[2].ValidationCode != "" {
		t.Fatalf("first usable duplicate candidate is invalid: %#v", rows[2])
	}
}

func TestParseCSVRejectsStructuralErrorsAndLimits(t *testing.T) {
	t.Parallel()

	documents := map[string][]byte{
		"empty":               nil,
		"missing email":       []byte("display_name\nAda\n"),
		"unknown column":      []byte("email,role\nada@example.test,ADMIN\n"),
		"malformed":           []byte("email,display_name\nada@example.test,\"Ada\n"),
		"invalid utf8":        {0xff, 0xfe},
		"too many rows":       []byte("email\n" + repeatedRows(MaxCSVRows+1)),
		"inconsistent fields": []byte("email,display_name\nada@example.test\n"),
	}
	for name, document := range documents {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := ParseCSV(document); !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("ParseCSV error = %v, want validation", err)
			}
		})
	}
}

func repeatedRows(count int) string {
	var builder strings.Builder
	for index := 0; index < count; index++ {
		fmt.Fprintf(&builder, "member%d@example.test\n", index)
	}
	return builder.String()
}
