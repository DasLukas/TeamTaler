package tabular

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"unicode"
)

var csvByteOrderMark = []byte{0xEF, 0xBB, 0xBF}

// WriteCSV validates document and writes a German spreadsheet-compatible CSV
// stream to output. The result uses UTF-8 with BOM, semicolons, CRLF line ends,
// RFC 4180 quoting, localized headers and display values, and formula-injection
// protection for all non-money cells.
//
// Write failures and validation failures are returned to the caller. The caller
// should render to a temporary file before starting an HTTP response.
//
// Example: err := tabular.WriteCSV(file, document)
func WriteCSV(output io.Writer, document Document) error {
	return WriteCSVContext(context.Background(), output, document)
}

// WriteCSVContext writes the same validated CSV as WriteCSV and aborts when
// ctx is cancelled or reaches its deadline. Context and output must be non-nil.
// It returns validation, cancellation, deadline, or write errors.
//
// Example: err := tabular.WriteCSVContext(ctx, file, document)
func WriteCSVContext(ctx context.Context, output io.Writer, document Document) error {
	if ctx == nil {
		return fmt.Errorf("CSV context must not be nil")
	}
	if output == nil {
		return fmt.Errorf("CSV output must not be nil")
	}
	if err := document.Validate(); err != nil {
		return fmt.Errorf("validate CSV document: %w", err)
	}
	output = contextWriter{context: ctx, writer: output}
	if _, err := output.Write(csvByteOrderMark); err != nil {
		return fmt.Errorf("write CSV byte-order mark: %w", err)
	}

	writer := csv.NewWriter(output)
	writer.Comma = ';'
	writer.UseCRLF = true
	headers := make([]string, len(document.Columns))
	for index, column := range document.Columns {
		headers[index] = cleanText(column.Header)
	}
	if err := writer.Write(headers); err != nil {
		return fmt.Errorf("write CSV header: %w", err)
	}
	values := make([]string, len(document.Columns))
	for rowIndex, row := range document.Rows {
		if err := ctx.Err(); err != nil {
			return err
		}
		for columnIndex, cell := range row.Cells {
			value := cellDisplay(document.Columns[columnIndex], cell)
			if document.Columns[columnIndex].Kind != MoneyColumn {
				value = protectSpreadsheetFormula(value)
			}
			values[columnIndex] = value
		}
		if err := writer.Write(values); err != nil {
			return fmt.Errorf("write CSV row %d: %w", rowIndex, err)
		}
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		return fmt.Errorf("flush CSV: %w", err)
	}
	return nil
}

type contextWriter struct {
	context context.Context
	writer  io.Writer
}

func (writer contextWriter) Write(content []byte) (int, error) {
	if err := writer.context.Err(); err != nil {
		return 0, err
	}
	return writer.writer.Write(content)
}

func protectSpreadsheetFormula(value string) string {
	for _, character := range value {
		if character == '=' || character == '+' || character == '-' || character == '@' || character == '\t' || character == '\r' {
			return "'" + value
		}
		if !unicode.IsSpace(character) {
			break
		}
	}
	return value
}
