// Package kiosk manages group-owned Scan and Go poster templates and PDFs.
package kiosk

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

const maxPosterProducts = 100

// Service persists poster templates and renders their current group catalog.
// Set DB to a migrated database, DataDirectory to normalized image storage, and
// PublicURL to the configured public origin before calling its methods.
// Construction has no side effects; methods report storage and rendering errors.
// Example: service := kiosk.Service{DB: db, DataDirectory: dataDir, PublicURL: origin}.
type Service struct {
	DB            *sql.DB
	DataDirectory string
	PublicURL     string
}

// Poster is one named, versioned group poster template returned by Service.
// ProductIDs preserve the administrator's chosen order and may later refer to
// archived products. IsDefault identifies the non-deletable booking-only poster;
// Version is supplied as If-Match on update and deletion.
type Poster struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Text       string   `json:"text"`
	ProductIDs []string `json:"productIds"`
	Version    int64    `json:"version"`
	IsDefault  bool     `json:"isDefault"`
}

// PosterInput replaces the editable fields of a poster. Name is required,
// Text is optional, and custom posters require at least one product. The
// standard poster accepts only name "Standard" and no products. Create and
// Update validate lengths, controls, duplicates, and product state.
type PosterInput struct {
	Name       string   `json:"name"`
	Text       string   `json:"text"`
	ProductIDs []string `json:"productIds"`
}

// List returns templates for membership's group with Standard first, then
// newest-first custom posters. ctx
// bounds the database reads; membership must have current group administration
// permission. It returns a non-nil empty slice when no templates exist, or an
// authorization, database, or context error.
// Example: posters, err := service.List(ctx, membership).
func (s Service) List(ctx context.Context, membership domain.Membership) ([]Poster, error) {
	if err := requireAdministration(ctx, s.DB, membership); err != nil {
		return nil, err
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT id,name,text,version,is_default FROM kiosk_posters WHERE group_id=? ORDER BY is_default DESC,updated_at DESC,id`, membership.GroupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Poster, 0)
	for rows.Next() {
		var item Poster
		if err := rows.Scan(&item.ID, &item.Name, &item.Text, &item.Version, &item.IsDefault); err != nil {
			return nil, err
		}
		item.ProductIDs = []string{}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for index := range items {
		ids, err := posterProductIDs(ctx, s.DB, membership.GroupID, items[index].ID)
		if err != nil {
			return nil, err
		}
		items[index].ProductIDs = ids
	}
	return items, nil
}

// Create stores input for actor's current group. ctx bounds the transaction,
// actor supplies audit identity, and membership supplies the tenant and current
// permission scope. It returns a version-one Poster or validation,
// authorization, audit, context, and database errors.
// Example: poster, err := service.Create(ctx, actor, membership, input).
func (s Service) Create(ctx context.Context, actor domain.Principal, membership domain.Membership, input PosterInput) (Poster, error) {
	id, err := platform.NewID("kpost")
	if err != nil {
		return Poster{}, err
	}
	now := platform.Timestamp(platform.Now())
	var item Poster
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireAdministration(ctx, tx, membership); err != nil {
			return err
		}
		input, err = validateInput(input)
		if err != nil {
			return err
		}
		if err := validateCustomPoster(input); err != nil {
			return err
		}
		if err := validateActiveProducts(ctx, tx, membership.GroupID, input.ProductIDs); err != nil {
			return err
		}
		item = Poster{ID: id, Name: input.Name, Text: input.Text, ProductIDs: input.ProductIDs, Version: 1}
		if _, err := tx.ExecContext(ctx, `INSERT INTO kiosk_posters(id,group_id,name,text,version,created_at,updated_at) VALUES(?,?,?,?,1,?,?)`,
			id, membership.GroupID, input.Name, input.Text, now, now); err != nil {
			return err
		}
		if err := replaceProductIDs(ctx, tx, membership.GroupID, id, input.ProductIDs); err != nil {
			return err
		}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "kiosk_poster.created", "kiosk_poster", id, input)
	})
	return item, err
}

// Update replaces input in membership's group only if version matches the
// current posterID version. ctx bounds the audited transaction and actor is
// recorded in the audit trail. It returns the incremented Poster or not-found,
// precondition, validation, authorization, context, audit, or database errors.
// Example: updated, err := service.Update(ctx, actor, membership, id, 1, input).
func (s Service) Update(ctx context.Context, actor domain.Principal, membership domain.Membership, posterID string, version int64, input PosterInput) (Poster, error) {
	if version < 1 {
		return Poster{}, domain.ErrPrecondition
	}
	input, err := validateInput(input)
	if err != nil {
		return Poster{}, err
	}
	now := platform.Timestamp(platform.Now())
	item := Poster{ID: posterID, Name: input.Name, Text: input.Text, ProductIDs: input.ProductIDs, Version: version + 1}
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireAdministration(ctx, tx, membership); err != nil {
			return err
		}
		var isDefault bool
		if err := tx.QueryRowContext(ctx, `SELECT is_default FROM kiosk_posters WHERE id=? AND group_id=?`, posterID, membership.GroupID).Scan(&isDefault); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return domain.ErrNotFound
			}
			return err
		}
		item.IsDefault = isDefault
		if isDefault {
			if input.Name != "Standard" {
				return domain.ValidationError{Field: "name", Message: "the standard poster name cannot be changed"}
			}
			if len(input.ProductIDs) != 0 {
				return domain.ValidationError{Field: "productIds", Message: "the standard poster cannot contain products"}
			}
		} else if err := validateCustomPoster(input); err != nil {
			return err
		}
		if err := validateActiveProducts(ctx, tx, membership.GroupID, input.ProductIDs); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `UPDATE kiosk_posters SET name=?,text=?,version=version+1,updated_at=? WHERE id=? AND group_id=? AND version=?`,
			input.Name, input.Text, now, posterID, membership.GroupID, version)
		if err != nil {
			return err
		}
		if err := expectOnePoster(ctx, tx, result, membership.GroupID, posterID); err != nil {
			return err
		}
		if err := replaceProductIDs(ctx, tx, membership.GroupID, posterID, input.ProductIDs); err != nil {
			return err
		}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "kiosk_poster.updated", "kiosk_poster", posterID, input)
	})
	return item, err
}

// Delete removes posterID from membership's group only at its expected version.
// ctx bounds the audited transaction and actor supplies audit identity. It
// returns no value on success, or not-found, precondition, authorization,
// context, audit, or database errors.
// Example: err := service.Delete(ctx, actor, membership, id, version).
func (s Service) Delete(ctx context.Context, actor domain.Principal, membership domain.Membership, posterID string, version int64) error {
	if version < 1 {
		return domain.ErrPrecondition
	}
	return storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireAdministration(ctx, tx, membership); err != nil {
			return err
		}
		var isDefault bool
		if err := tx.QueryRowContext(ctx, `SELECT is_default FROM kiosk_posters WHERE id=? AND group_id=?`, posterID, membership.GroupID).Scan(&isDefault); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return domain.ErrNotFound
			}
			return err
		}
		if isDefault {
			return fmt.Errorf("%w: the standard poster cannot be deleted", domain.ErrConflict)
		}
		result, err := tx.ExecContext(ctx, `DELETE FROM kiosk_posters WHERE id=? AND group_id=? AND version=?`, posterID, membership.GroupID, version)
		if err != nil {
			return err
		}
		if err := expectOnePoster(ctx, tx, result, membership.GroupID, posterID); err != nil {
			return err
		}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "kiosk_poster.deleted", "kiosk_poster", posterID, map[string]any{"version": version})
	})
}

func validateInput(input PosterInput) (PosterInput, error) {
	for _, character := range input.Name {
		if unicode.IsControl(character) || unicode.In(character, unicode.Cf) {
			return PosterInput{}, domain.ValidationError{Field: "name", Message: "must not contain control characters"}
		}
	}
	input.Name = strings.TrimSpace(input.Name)
	if utf8.RuneCountInString(input.Name) < 1 || utf8.RuneCountInString(input.Name) > 120 {
		return PosterInput{}, domain.ValidationError{Field: "name", Message: "must contain 1 to 120 characters"}
	}
	input.Text = strings.ReplaceAll(input.Text, "\r\n", "\n")
	for _, character := range input.Text {
		if character != '\n' && (unicode.IsControl(character) || unicode.In(character, unicode.Cf)) {
			return PosterInput{}, domain.ValidationError{Field: "text", Message: "must contain only printable characters and line breaks"}
		}
	}
	input.Text = strings.TrimSpace(input.Text)
	if utf8.RuneCountInString(input.Text) > 2000 {
		return PosterInput{}, domain.ValidationError{Field: "text", Message: "must contain at most 2000 characters"}
	}
	if len(input.ProductIDs) > maxPosterProducts {
		return PosterInput{}, domain.ValidationError{Field: "productIds", Message: "must contain at most 100 products"}
	}
	seen := make(map[string]bool, len(input.ProductIDs))
	for _, id := range input.ProductIDs {
		if id == "" || strings.TrimSpace(id) != id || seen[id] {
			return PosterInput{}, domain.ValidationError{Field: "productIds", Message: "must contain distinct product identifiers"}
		}
		seen[id] = true
	}
	if input.ProductIDs == nil {
		input.ProductIDs = []string{}
	}
	return input, nil
}

func validateCustomPoster(input PosterInput) error {
	if strings.EqualFold(input.Name, "Standard") {
		return domain.ValidationError{Field: "name", Message: "reserved for the standard poster"}
	}
	if len(input.ProductIDs) == 0 {
		return domain.ValidationError{Field: "productIds", Message: "custom posters must contain at least one product"}
	}
	return nil
}

func requireAdministration(ctx context.Context, queryer authorization.Queryer, membership domain.Membership) error {
	return authorization.Require(ctx, queryer, membership.GroupID, membership.ID, domain.PermissionGroupAdministration, authorization.GroupResource(membership.GroupID))
}

func validateActiveProducts(ctx context.Context, tx *sql.Tx, groupID string, ids []string) error {
	for _, id := range ids {
		var active int
		err := tx.QueryRowContext(ctx, `SELECT 1 FROM products p JOIN categories c ON c.id=p.category_id AND c.group_id=p.group_id
			WHERE p.group_id=? AND p.id=? AND p.active=1 AND p.deleted_at IS NULL AND c.active=1`, groupID, id).Scan(&active)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("%w: selected product is unavailable", domain.ErrConflict)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func replaceProductIDs(ctx context.Context, tx *sql.Tx, groupID, posterID string, ids []string) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM kiosk_poster_products WHERE group_id=? AND poster_id=?`, groupID, posterID); err != nil {
		return err
	}
	for index, id := range ids {
		if _, err := tx.ExecContext(ctx, `INSERT INTO kiosk_poster_products(group_id,poster_id,product_id,sort_order) VALUES(?,?,?,?)`, groupID, posterID, id, index); err != nil {
			return err
		}
	}
	return nil
}

func posterProductIDs(ctx context.Context, queryer authorization.Queryer, groupID, posterID string) ([]string, error) {
	rows, err := queryer.QueryContext(ctx, `SELECT product_id FROM kiosk_poster_products WHERE group_id=? AND poster_id=? ORDER BY sort_order`, groupID, posterID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func expectOnePoster(ctx context.Context, tx *sql.Tx, result sql.Result, groupID, posterID string) error {
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed == 1 {
		return nil
	}
	var existing int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM kiosk_posters WHERE group_id=? AND id=?`, groupID, posterID).Scan(&existing); err != nil {
		return err
	}
	if existing == 0 {
		return domain.ErrNotFound
	}
	return domain.ErrPrecondition
}
