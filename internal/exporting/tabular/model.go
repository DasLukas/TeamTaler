// Package tabular renders authorized, already-filtered table data as safe CSV
// and paginated PDF documents. It deliberately contains no database or HTTP
// concerns so callers remain responsible for authorization and query parity.
package tabular

import (
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	maxColumns        = 64
	maxTitleRunes     = 200
	maxGroupNameRunes = 120
	maxHeaderRunes    = 120
	maxLogoBytes      = 10 << 20
	maxCellImageBytes = 10 << 20
)

var (
	columnIDPattern = regexp.MustCompile(`\A[a-z][a-z0-9_]{0,63}\z`)
	currencyPattern = regexp.MustCompile(`\A[A-Z]{3}\z`)
)

// ColumnKind describes how a cell is validated, formatted, and aligned.
//
// TextColumn preserves the caller's visible text. MoneyColumn formats exact
// integer minor units without floating-point arithmetic.
type ColumnKind uint8

const (
	// TextColumn renders localized display text supplied by the table registry.
	TextColumn ColumnKind = iota
	// MoneyColumn renders Cell.Money using German separators and an ISO currency.
	MoneyColumn
)

// Alignment controls horizontal PDF cell alignment. CSV output is unaffected.
type Alignment uint8

const (
	// AlignDefault selects right alignment for money and left alignment otherwise.
	AlignDefault Alignment = iota
	// AlignLeft aligns content to the left edge of its PDF cell.
	AlignLeft
	// AlignCenter centers content in its PDF cell.
	AlignCenter
	// AlignRight aligns content to the right edge of its PDF cell.
	AlignRight
)

// CellTone selects an optional semantic PDF text color. CSV output always
// keeps the localized cell value without visual decoration.
type CellTone uint8

const (
	// ToneDefault renders the regular table text color.
	ToneDefault CellTone = iota
	// ToneWarning renders warning or booking values in amber.
	ToneWarning
	// ToneSuccess renders successful, settled, or credit values in green.
	ToneSuccess
	// ToneInfo renders informational or adjustment values in blue.
	ToneInfo
	// ToneDanger renders open, reversed, or deleted values in red.
	ToneDanger
)

// Document is the canonical, transport-independent representation of one table
// export. ExportedAt must already carry the validated display timezone. GroupName
// is rendered beside LogoPNG in group exports; missing or invalid logo bytes use
// the built-in TeamTaler mark instead. System exports leave GroupName empty.
//
// Example:
//
//	doc := tabular.Document{
//		Title: "Aktivitaeten",
//		ExportedAt: time.Now(),
//		Columns: []tabular.Column{{ID: "member", Header: "Mitglied"}},
//		Rows: []tabular.Row{{Cells: []tabular.Cell{{Text: "Alex"}}}},
//	}
type Document struct {
	Title      string
	GroupName  string
	ExportedAt time.Time
	LogoPNG    []byte
	Columns    []Column
	Rows       []Row
}

// Column defines one stable table column. WidthMM is a preferred PDF width in
// millimetres; zero selects a kind-aware default. Identity columns are repeated
// in every horizontal band when the complete table is wider than A4 landscape.
type Column struct {
	ID        string
	Header    string
	Kind      ColumnKind
	Alignment Alignment
	WidthMM   float64
	Identity  bool
}

// Row contains cells in exactly the same order as Document.Columns.
type Row struct {
	Cells []Cell
}

// Cell contains either visible Text or exact Money according to its column kind.
// A money cell must set Money and leave Text empty; a text cell must do the
// inverse. Newlines in text are preserved and wrapped in PDF output. ImagePNG,
// ImageSlot, and Tone are optional PDF-only presentation metadata; ImageSlot
// keeps text aligned when a neighboring row has an image. CSV output
// deliberately ignores all three and remains text-only.
type Cell struct {
	Text      string
	Money     *Money
	ImagePNG  []byte
	ImageSlot bool
	Tone      CellTone
}

// Money stores an exact signed integer amount in minor units. DecimalPlaces is
// the ISO currency exponent selected by the caller, for example 2 for EUR and 0
// for JPY. Values are parsed as arbitrary-precision integers.
//
// Example: Money{MinorUnits: "-1250", Currency: "EUR", DecimalPlaces: 2}
// renders as "-12,50 EUR".
type Money struct {
	MinorUnits    string
	Currency      string
	DecimalPlaces uint8
}

// Validate checks structural limits and typed cell invariants before rendering.
// It returns a descriptive error for malformed titles, columns, rows, or money
// and does not mutate the document. Invalid logos intentionally remain a
// renderer-level fallback condition rather than failing the complete export.
//
// Example: if err := doc.Validate(); err != nil { return err }
func (document Document) Validate() error {
	title := strings.TrimSpace(document.Title)
	if title == "" {
		return errors.New("table title must not be empty")
	}
	if utf8.RuneCountInString(title) > maxTitleRunes {
		return fmt.Errorf("table title exceeds %d characters", maxTitleRunes)
	}
	if utf8.RuneCountInString(strings.TrimSpace(document.GroupName)) > maxGroupNameRunes {
		return fmt.Errorf("group name exceeds %d characters", maxGroupNameRunes)
	}
	if document.ExportedAt.IsZero() {
		return errors.New("export timestamp must not be zero")
	}
	if len(document.Columns) == 0 {
		return errors.New("table must contain at least one column")
	}
	if len(document.Columns) > maxColumns {
		return fmt.Errorf("table exceeds %d columns", maxColumns)
	}

	seenIDs := make(map[string]struct{}, len(document.Columns))
	for index, column := range document.Columns {
		if !columnIDPattern.MatchString(column.ID) {
			return fmt.Errorf("column %d has an invalid ID", index)
		}
		if _, exists := seenIDs[column.ID]; exists {
			return fmt.Errorf("column ID %q is duplicated", column.ID)
		}
		seenIDs[column.ID] = struct{}{}
		if strings.TrimSpace(column.Header) == "" {
			return fmt.Errorf("column %q has an empty header", column.ID)
		}
		if utf8.RuneCountInString(column.Header) > maxHeaderRunes {
			return fmt.Errorf("column %q header exceeds %d characters", column.ID, maxHeaderRunes)
		}
		if column.Kind != TextColumn && column.Kind != MoneyColumn {
			return fmt.Errorf("column %q has an unsupported kind", column.ID)
		}
		if column.Alignment > AlignRight {
			return fmt.Errorf("column %q has an unsupported alignment", column.ID)
		}
		if column.WidthMM < 0 || column.WidthMM > 277 {
			return fmt.Errorf("column %q width must be between 0 and 277 millimetres", column.ID)
		}
	}

	for rowIndex, row := range document.Rows {
		if len(row.Cells) != len(document.Columns) {
			return fmt.Errorf("row %d contains %d cells, want %d", rowIndex, len(row.Cells), len(document.Columns))
		}
		for columnIndex, cell := range row.Cells {
			column := document.Columns[columnIndex]
			if len(cell.ImagePNG) > maxCellImageBytes {
				return fmt.Errorf("row %d column %q image exceeds %d bytes", rowIndex, column.ID, maxCellImageBytes)
			}
			if cell.Tone > ToneDanger {
				return fmt.Errorf("row %d column %q has an unsupported tone", rowIndex, column.ID)
			}
			switch column.Kind {
			case TextColumn:
				if cell.Money != nil {
					return fmt.Errorf("row %d column %q contains money in a text column", rowIndex, column.ID)
				}
			case MoneyColumn:
				if len(cell.ImagePNG) > 0 || cell.ImageSlot {
					return fmt.Errorf("row %d column %q decorates a money column", rowIndex, column.ID)
				}
				if cell.Money == nil {
					return fmt.Errorf("row %d column %q has no money value", rowIndex, column.ID)
				}
				if cell.Text != "" {
					return fmt.Errorf("row %d column %q contains text in a money column", rowIndex, column.ID)
				}
				if err := cell.Money.validate(); err != nil {
					return fmt.Errorf("row %d column %q: %w", rowIndex, column.ID, err)
				}
			}
		}
	}
	return nil
}

func (money Money) validate() error {
	if !currencyPattern.MatchString(money.Currency) {
		return errors.New("currency must be a three-letter uppercase code")
	}
	if money.DecimalPlaces > 9 {
		return errors.New("decimal places must not exceed 9")
	}
	if money.MinorUnits == "" || strings.HasPrefix(money.MinorUnits, "+") {
		return errors.New("minor units must be a canonical signed integer")
	}
	parsed, ok := new(big.Int).SetString(money.MinorUnits, 10)
	if !ok || parsed.String() != money.MinorUnits {
		return errors.New("minor units must be a canonical signed integer")
	}
	return nil
}

func cellDisplay(column Column, cell Cell) string {
	if column.Kind == MoneyColumn {
		return formatMoney(*cell.Money)
	}
	return cleanText(cell.Text)
}

func formatMoney(money Money) string {
	amount, _ := new(big.Int).SetString(money.MinorUnits, 10)
	sign := ""
	if amount.Sign() < 0 {
		sign = "-"
		amount.Abs(amount)
	}
	digits := amount.String()
	places := int(money.DecimalPlaces)
	if places > 0 && len(digits) <= places {
		digits = strings.Repeat("0", places-len(digits)+1) + digits
	}
	whole := digits
	fraction := ""
	if places > 0 {
		whole = digits[:len(digits)-places]
		fraction = "," + digits[len(digits)-places:]
	}

	var grouped strings.Builder
	for index, digit := range whole {
		if index > 0 && (len(whole)-index)%3 == 0 {
			grouped.WriteByte('.')
		}
		grouped.WriteRune(digit)
	}
	return sign + grouped.String() + fraction + " " + money.Currency
}

func cleanText(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "\x00", "�"), "\r\n", "\n")
}
