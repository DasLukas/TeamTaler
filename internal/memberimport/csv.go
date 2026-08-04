// Package memberimport parses bounded member invitation CSV files.
package memberimport

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

const (
	// MaxCSVBytes is the largest accepted member import document.
	MaxCSVBytes = 256 * 1024
	// MaxCSVRows bounds invitation creation and outbound mail fan-out per request.
	MaxCSVRows = 100
	// CodeInvalidEmail identifies a row whose email field is unusable.
	CodeInvalidEmail = "invalid_email"
	// CodeDisplayNameTooLong identifies a row whose optional name is too long.
	CodeDisplayNameTooLong = "display_name_too_long"
	// CodeInvalidDisplayName identifies a name containing unsafe controls.
	CodeInvalidDisplayName = "invalid_display_name"
	// CodeDuplicateEmail identifies a repeated normalized address in one file.
	CodeDuplicateEmail = "duplicate_email"
)

// Row is one normalized member invitation candidate. ValidationCode is empty
// for a usable row and contains a stable machine-readable code otherwise.
type Row struct {
	Number         int
	Email          string
	DisplayName    string
	ValidationCode string
}

// ParseCSV validates a UTF-8 member import document with an email column and an
// optional display_name column. Comma and semicolon delimiters and a UTF-8 BOM
// are supported. Structural document errors are returned as validation errors;
// row-level errors remain attached to their row so callers can report partial
// results. Example: ParseCSV([]byte("email,display_name\na@example.test,Ada"))
// returns one normalized row.
func ParseCSV(document []byte) ([]Row, error) {
	if len(document) == 0 {
		return nil, domain.ValidationError{Field: "file", Message: "must not be empty"}
	}
	if len(document) > MaxCSVBytes {
		return nil, domain.ValidationError{Field: "file", Message: fmt.Sprintf("must not exceed %d bytes", MaxCSVBytes)}
	}
	document = bytes.TrimPrefix(document, []byte{0xef, 0xbb, 0xbf})
	if !utf8.Valid(document) {
		return nil, domain.ValidationError{Field: "file", Message: "must be valid UTF-8"}
	}

	reader := csv.NewReader(bytes.NewReader(document))
	reader.Comma = detectDelimiter(document)
	reader.TrimLeadingSpace = true
	reader.ReuseRecord = false
	header, err := reader.Read()
	if errors.Is(err, io.EOF) {
		return nil, domain.ValidationError{Field: "file", Message: "must contain a header row"}
	}
	if err != nil {
		return nil, malformedCSV(err)
	}

	emailIndex, displayNameIndex, err := parseHeader(header)
	if err != nil {
		return nil, err
	}
	reader.FieldsPerRecord = -1

	rows := make([]Row, 0)
	seenEmails := make(map[string]struct{})
	for {
		record, readErr := reader.Read()
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return nil, malformedCSV(readErr)
		}
		if recordIsBlank(record) {
			continue
		}
		if len(record) != len(header) {
			return nil, domain.ValidationError{Field: "file", Message: fmt.Sprintf("row has %d columns; expected %d", len(record), len(header))}
		}
		if len(rows) >= MaxCSVRows {
			return nil, domain.ValidationError{Field: "file", Message: fmt.Sprintf("must contain at most %d data rows", MaxCSVRows)}
		}

		line, _ := reader.FieldPos(0)
		row := Row{Number: line, DisplayName: valueAt(record, displayNameIndex)}
		email, emailErr := platform.NormalizeEmail(valueAt(record, emailIndex))
		row.Email = email
		switch {
		case emailErr != nil:
			row.ValidationCode = CodeInvalidEmail
		case len(row.DisplayName) > 120:
			row.ValidationCode = CodeDisplayNameTooLong
		case containsControlCharacter(row.DisplayName):
			row.ValidationCode = CodeInvalidDisplayName
		default:
			if _, duplicate := seenEmails[email]; duplicate {
				row.ValidationCode = CodeDuplicateEmail
			} else {
				seenEmails[email] = struct{}{}
			}
		}
		rows = append(rows, row)
	}
	if len(rows) == 0 {
		return nil, domain.ValidationError{Field: "file", Message: "must contain at least one data row"}
	}
	return rows, nil
}

func detectDelimiter(document []byte) rune {
	headerLine := document
	if newline := bytes.IndexByte(document, '\n'); newline >= 0 {
		headerLine = document[:newline]
	}
	if bytes.Count(headerLine, []byte(";")) > bytes.Count(headerLine, []byte(",")) {
		return ';'
	}
	return ','
}

func parseHeader(header []string) (int, int, error) {
	emailIndex := -1
	displayNameIndex := -1
	for index, raw := range header {
		name := strings.ToLower(strings.TrimSpace(raw))
		switch name {
		case "email":
			if emailIndex >= 0 {
				return 0, 0, domain.ValidationError{Field: "file", Message: "header contains email more than once"}
			}
			emailIndex = index
		case "display_name":
			if displayNameIndex >= 0 {
				return 0, 0, domain.ValidationError{Field: "file", Message: "header contains display_name more than once"}
			}
			displayNameIndex = index
		default:
			return 0, 0, domain.ValidationError{Field: "file", Message: fmt.Sprintf("header contains unsupported column %q", name)}
		}
	}
	if emailIndex < 0 {
		return 0, 0, domain.ValidationError{Field: "file", Message: "header must contain an email column"}
	}
	return emailIndex, displayNameIndex, nil
}

func valueAt(record []string, index int) string {
	if index < 0 {
		return ""
	}
	return strings.TrimSpace(record[index])
}

func recordIsBlank(record []string) bool {
	for _, value := range record {
		if strings.TrimSpace(value) != "" {
			return false
		}
	}
	return true
}

func containsControlCharacter(value string) bool {
	for _, character := range value {
		if character < 32 || character == 127 {
			return true
		}
	}
	return false
}

func malformedCSV(err error) error {
	return domain.ValidationError{Field: "file", Message: "must be well-formed CSV: " + err.Error()}
}
