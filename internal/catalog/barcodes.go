package catalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/domain"
)

type normalizedBarcode struct {
	domain.ProductBarcode
	key string
}

func normalizeBarcodes(input []domain.ProductBarcode) ([]normalizedBarcode, error) {
	if len(input) > 50 {
		return nil, domain.ValidationError{Field: "barcodes", Message: "must contain no more than 50 codes"}
	}
	result := make([]normalizedBarcode, 0, len(input))
	seen := make(map[string]bool, len(input))
	for index, item := range input {
		item.Value = strings.TrimSpace(item.Value)
		key, err := barcodeKey(item)
		if err != nil {
			var validation domain.ValidationError
			if errors.As(err, &validation) {
				return nil, domain.ValidationError{Field: fmt.Sprintf("barcodes[%d].value", index), Message: validation.Message}
			}
			return nil, err
		}
		if seen[key] {
			return nil, domain.ValidationError{Field: fmt.Sprintf("barcodes[%d].value", index), Message: "contains the same code more than once"}
		}
		seen[key] = true
		result = append(result, normalizedBarcode{ProductBarcode: item, key: key})
	}
	return result, nil
}

// BarcodeKey validates a supported retail or Code 128 value and returns the
// canonical lookup key used to resolve equivalent UPC/EAN representations.
// Parameters: item is the format and scanned value. Returns a canonical key or
// a validation error. Example: BarcodeKey(domain.ProductBarcode{Format: "UPC_A", Value: "036000291452"}).
func BarcodeKey(item domain.ProductBarcode) (string, error) {
	return barcodeKey(item)
}

func barcodeKey(item domain.ProductBarcode) (string, error) {
	value := strings.TrimSpace(item.Value)
	switch item.Format {
	case "EAN_8":
		if !validGTIN(value, 8) {
			return "", invalidBarcode()
		}
		return "GTIN:" + strings.Repeat("0", 6) + value, nil
	case "EAN_13":
		if !validGTIN(value, 13) {
			return "", invalidBarcode()
		}
		return "GTIN:0" + value, nil
	case "UPC_A":
		if !validGTIN(value, 12) {
			return "", invalidBarcode()
		}
		return "GTIN:00" + value, nil
	case "UPC_E":
		if len(value) != 8 || !allDigits(value) || (value[0] != '0' && value[0] != '1') {
			return "", invalidBarcode()
		}
		prefix := value[:1]
		digits := value[1:7]
		var expanded string
		switch digits[5] {
		case '0', '1', '2':
			expanded = prefix + digits[:2] + digits[5:6] + "0000" + digits[2:5]
		case '3':
			expanded = prefix + digits[:3] + "00000" + digits[3:5]
		case '4':
			expanded = prefix + digits[:4] + "00000" + digits[4:5]
		default:
			expanded = prefix + digits[:5] + "0000" + digits[5:6]
		}
		upcA := expanded + value[7:]
		if !validGTIN(upcA, 12) {
			return "", invalidBarcode()
		}
		return "GTIN:00" + upcA, nil
	case "CODE_128":
		if len(value) < 1 || len(value) > 80 {
			return "", invalidBarcode()
		}
		for _, character := range value {
			if character < 32 || character > 126 {
				return "", invalidBarcode()
			}
		}
		return "CODE128:" + value, nil
	default:
		return "", domain.ValidationError{Field: "barcodes", Message: "contains an unsupported format"}
	}
}

func validGTIN(value string, length int) bool {
	if len(value) != length || !allDigits(value) {
		return false
	}
	sum := 0
	weight := 3
	for index := len(value) - 2; index >= 0; index-- {
		sum += int(value[index]-'0') * weight
		weight = 4 - weight
	}
	return (10-sum%10)%10 == int(value[len(value)-1]-'0')
}

func allDigits(value string) bool {
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

func invalidBarcode() error {
	return domain.ValidationError{Field: "barcodes", Message: "contains an invalid value or check digit"}
}

func replaceProductBarcodes(ctx context.Context, tx *sql.Tx, groupID, productID string, barcodes []normalizedBarcode) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM product_barcodes WHERE group_id=? AND product_id=?`, groupID, productID); err != nil {
		return err
	}
	for index, item := range barcodes {
		var owner string
		err := tx.QueryRowContext(ctx, `SELECT product_id FROM product_barcodes WHERE group_id=? AND normalized_key=?`, groupID, item.key).Scan(&owner)
		if err == nil && owner != productID {
			return fmt.Errorf("%w: barcode[%d] is assigned to another product", domain.ErrConflict, index)
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO product_barcodes(group_id,product_id,format,value,normalized_key,sort_order) VALUES(?,?,?,?,?,?)`, groupID, productID, item.Format, item.Value, item.key, index); err != nil {
			if strings.Contains(err.Error(), "product_barcodes.group_id, product_barcodes.normalized_key") {
				return fmt.Errorf("%w: barcode[%d] is assigned to another product", domain.ErrConflict, index)
			}
			return err
		}
	}
	return nil
}

func loadProductBarcodes(ctx context.Context, tx *sql.Tx, groupID, productID string) ([]domain.ProductBarcode, error) {
	rows, err := tx.QueryContext(ctx, `SELECT format,value FROM product_barcodes WHERE group_id=? AND product_id=? ORDER BY sort_order`, groupID, productID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.ProductBarcode, 0)
	for rows.Next() {
		var item domain.ProductBarcode
		if err := rows.Scan(&item.Format, &item.Value); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}
