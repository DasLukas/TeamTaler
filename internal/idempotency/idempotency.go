// Package idempotency stores and replays mutation results inside caller transactions.
package idempotency

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

// ValidateKey checks the shared public Idempotency-Key length contract.
// It returns a validation error for keys outside 8 to 200 characters.
func ValidateKey(key string) error {
	if len(key) < 8 || len(key) > 200 {
		return domain.ValidationError{Field: "Idempotency-Key", Message: "must contain 8 to 200 characters"}
	}
	return nil
}

// Hash serializes value as canonical Go JSON and returns a SHA-256 request hash.
// It returns the hash or a JSON encoding error.
func Hash(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

// Load checks a key inside tx and decodes a matching stored response into target.
// It returns found=false for a new key, ErrIdempotencyReuse for a different
// request hash, or SQL/JSON errors. groupID and userID define key ownership.
func Load(ctx context.Context, tx *sql.Tx, groupID, userID, key, requestHash string, target any) (bool, error) {
	var storedHash, storedResponse string
	err := tx.QueryRowContext(ctx, `SELECT request_hash,response_json FROM idempotency_results WHERE group_id=? AND actor_user_id=? AND idempotency_key=?`, groupID, userID, key).
		Scan(&storedHash, &storedResponse)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if storedHash != requestHash {
		return false, domain.ErrIdempotencyReuse
	}
	if err := json.Unmarshal([]byte(storedResponse), target); err != nil {
		return false, err
	}
	return true, nil
}

// Store persists value for key in the caller's transaction.
// statusCode records the original HTTP result. It returns JSON or SQL errors and
// relies on the table primary key to reject concurrent duplicate execution.
func Store(ctx context.Context, tx *sql.Tx, groupID, userID, key, requestHash string, statusCode int, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO idempotency_results(group_id,actor_user_id,idempotency_key,request_hash,status_code,response_json,created_at) VALUES(?,?,?,?,?,?,?)`,
		groupID, userID, key, requestHash, statusCode, string(encoded), platform.Timestamp(platform.Now()))
	return err
}
