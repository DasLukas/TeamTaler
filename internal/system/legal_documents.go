package system

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

const (
	// MaximumLegalDocumentBytes is the maximum UTF-8 size of one legal document.
	MaximumLegalDocumentBytes = 64 * 1024
)

var allLegalDocumentKeys = []LegalDocumentKey{LegalDocumentImprint, LegalDocumentPrivacyPolicy}

type legalDocumentState struct {
	revision        int64
	updatedAt       string
	updatedByUserID sql.NullString
}

type storedLegalDocument struct {
	content   string
	version   int64
	updatedAt string
}

// GetLegalDocuments returns every effective legal document with safe source
// metadata for system administration. Database overrides take precedence over
// live host files.
func (s Service) GetLegalDocuments(ctx context.Context) (LegalDocuments, error) {
	return s.loadLegalDocuments(ctx, s.db)
}

// GetPublicLegalDocuments returns only the effective Markdown content needed
// by unauthenticated legal pages.
func (s Service) GetPublicLegalDocuments(ctx context.Context) (PublicLegalDocuments, error) {
	documents, err := s.loadLegalDocuments(ctx, s.db)
	if err != nil {
		return PublicLegalDocuments{}, err
	}
	return PublicLegalDocuments{
		Imprint: documents.Imprint.Content, PrivacyPolicy: documents.PrivacyPolicy.Content,
	}, nil
}

// UpdateLegalDocuments validates and persists supplied complete document
// replacements when expectedRevision is current and actorUserID remains an
// active system administrator.
func (s Service) UpdateLegalDocuments(ctx context.Context, actorUserID string, expectedRevision int64, patch LegalDocumentsPatch) (LegalDocuments, error) {
	if expectedRevision < 1 {
		return LegalDocuments{}, fmt.Errorf("%w: a current legal-documents revision is required", domain.ErrPrecondition)
	}
	updates := make(map[LegalDocumentKey]string, 2)
	if patch.Imprint != nil {
		content, err := normalizeLegalDocument(*patch.Imprint, false)
		if err != nil {
			return LegalDocuments{}, domain.ValidationError{Field: "imprint", Message: err.Error()}
		}
		updates[LegalDocumentImprint] = content
	}
	if patch.PrivacyPolicy != nil {
		content, err := normalizeLegalDocument(*patch.PrivacyPolicy, false)
		if err != nil {
			return LegalDocuments{}, domain.ValidationError{Field: "privacyPolicy", Message: err.Error()}
		}
		updates[LegalDocumentPrivacyPolicy] = content
	}
	if len(updates) == 0 {
		return LegalDocuments{}, domain.ValidationError{Message: "at least one legal document is required"}
	}

	var result LegalDocuments
	err := storage.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		if err := requireAdministratorTx(ctx, tx, actorUserID); err != nil {
			return err
		}
		state, err := readLegalDocumentState(ctx, tx)
		if err != nil {
			return err
		}
		if state.revision != expectedRevision {
			return domain.ErrPrecondition
		}
		now := platform.Timestamp(platform.Now())
		updatedKeys := make([]string, 0, len(updates))
		for _, key := range allLegalDocumentKeys {
			content, present := updates[key]
			if !present {
				continue
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO legal_document_overrides(
				document_key,content,version,updated_at,updated_by_user_id
			) VALUES(?,?,1,?,?) ON CONFLICT(document_key) DO UPDATE SET
				content=excluded.content,
				version=legal_document_overrides.version+1,
				updated_at=excluded.updated_at,
				updated_by_user_id=excluded.updated_by_user_id`, key, content, now, actorUserID); err != nil {
				return fmt.Errorf("persist legal document %q: %w", key, err)
			}
			updatedKeys = append(updatedKeys, string(key))
		}
		if err := advanceLegalDocumentRevision(ctx, tx, expectedRevision, actorUserID, now); err != nil {
			return err
		}
		if err := RecordAudit(ctx, tx, actorUserID, "system.legal_documents.updated", "legal_documents", "singleton", map[string]any{
			"previousRevision": expectedRevision,
			"revision":         expectedRevision + 1,
			"keys":             updatedKeys,
		}); err != nil {
			return err
		}
		result, err = s.loadLegalDocuments(ctx, tx)
		return err
	})
	return result, err
}

// ResetLegalDocuments removes selected database overrides so their current
// host-file or built-in value becomes effective.
func (s Service) ResetLegalDocuments(ctx context.Context, actorUserID string, expectedRevision int64, keys []LegalDocumentKey) (LegalDocuments, error) {
	if expectedRevision < 1 {
		return LegalDocuments{}, fmt.Errorf("%w: a current legal-documents revision is required", domain.ErrPrecondition)
	}
	uniqueKeys, err := validateLegalDocumentKeys(keys)
	if err != nil {
		return LegalDocuments{}, err
	}
	if len(uniqueKeys) == 0 {
		return LegalDocuments{}, domain.ValidationError{Field: "keys", Message: "must contain at least one legal document key"}
	}

	var result LegalDocuments
	err = storage.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		if err := requireAdministratorTx(ctx, tx, actorUserID); err != nil {
			return err
		}
		state, err := readLegalDocumentState(ctx, tx)
		if err != nil {
			return err
		}
		if state.revision != expectedRevision {
			return domain.ErrPrecondition
		}
		removedKeys := make([]string, 0, len(uniqueKeys))
		for _, key := range uniqueKeys {
			deleteResult, err := tx.ExecContext(ctx, `DELETE FROM legal_document_overrides WHERE document_key=?`, key)
			if err != nil {
				return fmt.Errorf("reset legal document %q: %w", key, err)
			}
			affected, err := deleteResult.RowsAffected()
			if err != nil {
				return fmt.Errorf("count reset legal document %q: %w", key, err)
			}
			if affected == 1 {
				removedKeys = append(removedKeys, string(key))
			}
		}
		if len(removedKeys) == 0 {
			result, err = s.loadLegalDocuments(ctx, tx)
			return err
		}
		now := platform.Timestamp(platform.Now())
		if err := advanceLegalDocumentRevision(ctx, tx, expectedRevision, actorUserID, now); err != nil {
			return err
		}
		if err := RecordAudit(ctx, tx, actorUserID, "system.legal_documents.reset", "legal_documents", "singleton", map[string]any{
			"previousRevision": expectedRevision,
			"revision":         expectedRevision + 1,
			"keys":             removedKeys,
		}); err != nil {
			return err
		}
		result, err = s.loadLegalDocuments(ctx, tx)
		return err
	})
	return result, err
}

func (s Service) loadLegalDocuments(ctx context.Context, queryer settingsQueryer) (LegalDocuments, error) {
	state, err := readLegalDocumentState(ctx, queryer)
	if err != nil {
		return LegalDocuments{}, err
	}
	rows, err := queryer.QueryContext(ctx, `SELECT document_key,content,version,updated_at
		FROM legal_document_overrides ORDER BY document_key`)
	if err != nil {
		return LegalDocuments{}, fmt.Errorf("query legal document overrides: %w", err)
	}
	defer rows.Close()
	overrides := make(map[LegalDocumentKey]storedLegalDocument, 2)
	for rows.Next() {
		var key LegalDocumentKey
		var document storedLegalDocument
		if err := rows.Scan(&key, &document.content, &document.version, &document.updatedAt); err != nil {
			return LegalDocuments{}, fmt.Errorf("scan legal document override: %w", err)
		}
		if !isLegalDocumentKey(key) {
			return LegalDocuments{}, fmt.Errorf("unsupported stored legal document key %q", key)
		}
		if _, err := normalizeLegalDocument(document.content, false); err != nil {
			return LegalDocuments{}, fmt.Errorf("invalid stored legal document %q: %w", key, err)
		}
		overrides[key] = document
	}
	if err := rows.Err(); err != nil {
		return LegalDocuments{}, fmt.Errorf("iterate legal document overrides: %w", err)
	}

	imprint, err := s.resolveLegalDocument(LegalDocumentImprint, overrides)
	if err != nil {
		return LegalDocuments{}, err
	}
	privacyPolicy, err := s.resolveLegalDocument(LegalDocumentPrivacyPolicy, overrides)
	if err != nil {
		return LegalDocuments{}, err
	}
	documents := LegalDocuments{
		Revision: state.revision, Imprint: imprint, PrivacyPolicy: privacyPolicy, UpdatedAt: state.updatedAt,
	}
	if state.updatedByUserID.Valid {
		documents.UpdatedByUserID = &state.updatedByUserID.String
	}
	return documents, nil
}

func (s Service) resolveLegalDocument(key LegalDocumentKey, overrides map[LegalDocumentKey]storedLegalDocument) (LegalDocument, error) {
	if override, present := overrides[key]; present {
		return LegalDocument{
			Content: override.content, Source: LegalDocumentSourceDatabase, Configured: true,
			OverrideVersion: override.version, UpdatedAt: override.updatedAt,
		}, nil
	}
	path := s.legalFiles[key]
	if path == "" {
		return LegalDocument{Source: LegalDocumentSourceCode}, nil
	}
	file, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return LegalDocument{Source: LegalDocumentSourceCode}, nil
	}
	if err != nil {
		return LegalDocument{}, fmt.Errorf("open host legal document %q: %w", key, err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return LegalDocument{}, fmt.Errorf("inspect host legal document %q: %w", key, err)
	}
	if !info.Mode().IsRegular() {
		return LegalDocument{}, fmt.Errorf("host legal document %q must be a regular file", key)
	}
	contentBytes, err := io.ReadAll(io.LimitReader(file, MaximumLegalDocumentBytes+1))
	if err != nil {
		return LegalDocument{}, fmt.Errorf("read host legal document %q: %w", key, err)
	}
	if len(contentBytes) > MaximumLegalDocumentBytes {
		return LegalDocument{}, fmt.Errorf("host legal document %q exceeds %d bytes", key, MaximumLegalDocumentBytes)
	}
	content, err := normalizeLegalDocument(string(contentBytes), true)
	if err != nil {
		return LegalDocument{}, fmt.Errorf("invalid host legal document %q: %w", key, err)
	}
	return LegalDocument{
		Content: content, Source: LegalDocumentSourceFile, Configured: content != "",
		UpdatedAt: platform.Timestamp(info.ModTime().UTC()),
	}, nil
}

func normalizeLegalDocument(content string, allowEmpty bool) (string, error) {
	if !utf8.ValidString(content) {
		return "", fmt.Errorf("must be valid UTF-8")
	}
	content = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(content, "\r\n", "\n"), "\r", "\n"))
	if !allowEmpty && content == "" {
		return "", fmt.Errorf("must not be empty")
	}
	if len([]byte(content)) > MaximumLegalDocumentBytes {
		return "", fmt.Errorf("must contain at most %d UTF-8 bytes", MaximumLegalDocumentBytes)
	}
	for _, character := range content {
		if character == '\x00' || character == '\x7f' || character < 32 && character != '\n' && character != '\t' {
			return "", fmt.Errorf("must not contain unsupported control characters")
		}
	}
	return content, nil
}

func validateLegalDocumentKeys(keys []LegalDocumentKey) ([]LegalDocumentKey, error) {
	seen := make(map[LegalDocumentKey]struct{}, len(keys))
	result := make([]LegalDocumentKey, 0, len(keys))
	for _, key := range keys {
		if !isLegalDocumentKey(key) {
			return nil, domain.ValidationError{Field: "keys", Message: fmt.Sprintf("contains unsupported legal document %q", key)}
		}
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, key)
	}
	return result, nil
}

func isLegalDocumentKey(key LegalDocumentKey) bool {
	return key == LegalDocumentImprint || key == LegalDocumentPrivacyPolicy
}

func readLegalDocumentState(ctx context.Context, queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}) (legalDocumentState, error) {
	var state legalDocumentState
	err := queryer.QueryRowContext(ctx, `SELECT revision,updated_at,updated_by_user_id
		FROM legal_documents_state WHERE singleton=1`).Scan(&state.revision, &state.updatedAt, &state.updatedByUserID)
	if err != nil {
		return legalDocumentState{}, fmt.Errorf("read legal documents state: %w", err)
	}
	return state, nil
}

func advanceLegalDocumentRevision(ctx context.Context, tx *sql.Tx, expectedRevision int64, actorUserID, now string) error {
	result, err := tx.ExecContext(ctx, `UPDATE legal_documents_state
		SET revision=revision+1,updated_at=?,updated_by_user_id=?
		WHERE singleton=1 AND revision=?`, now, actorUserID, expectedRevision)
	if err != nil {
		return fmt.Errorf("advance legal documents revision: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("count legal documents revision update: %w", err)
	}
	if affected != 1 {
		return domain.ErrPrecondition
	}
	return nil
}
