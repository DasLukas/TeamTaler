// Package catalog manages categories, products, and normalized product images.
package catalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/idempotency"
	"github.com/DasLukas/TeamTaler/internal/media"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

// Service implements catalog commands and queries over a migrated TeamTaler
// database.
type Service struct {
	// DB is the shared application database connection pool.
	DB *sql.DB
}

// CreateCategoryInput is the public category creation command. Service methods
// validate its name and supported limits before persistence.
type CreateCategoryInput struct {
	Name      string              `json:"name"`
	Icon      domain.CategoryIcon `json:"icon"`
	SortOrder int                 `json:"sortOrder"`
}

// UpdateCategoryInput describes a full optimistic category update; Version must
// match the current persisted version.
type UpdateCategoryInput struct {
	Name      string              `json:"name"`
	Icon      domain.CategoryIcon `json:"icon"`
	Active    bool                `json:"active"`
	SortOrder int                 `json:"sortOrder"`
	Version   int64               `json:"version"`
}

// CreateProductInput is the public product creation command expressed in the
// owning group's minor currency unit.
type CreateProductInput struct {
	Name        string                    `json:"name"`
	PriceMinor  *int64                    `json:"priceMinor,omitempty"`
	PricingMode domain.ProductPricingMode `json:"pricingMode,omitempty"`
	SortOrder   int                       `json:"sortOrder"`
}

// UpdateProductInput describes a full optimistic product update; Version must
// match the current persisted version and historical booking snapshots remain unchanged.
type UpdateProductInput struct {
	Name        string                    `json:"name"`
	PriceMinor  *int64                    `json:"priceMinor,omitempty"`
	PricingMode domain.ProductPricingMode `json:"pricingMode,omitempty"`
	Active      bool                      `json:"active"`
	SortOrder   int                       `json:"sortOrder"`
	Version     int64                     `json:"version"`
}

// ReorderInput replaces the complete category order and each category's
// complete product order. Product identifiers may not move between categories.
type ReorderInput struct {
	CategoryIDs          []string            `json:"categoryIds"`
	ProductIDsByCategory map[string][]string `json:"productIdsByCategory"`
}

const maxCatalogOrderItems = 1000

// List returns all categories and products for groupID in display order. ctx
// bounds database access; an empty slice is valid and SQL errors propagate.
func (s Service) List(ctx context.Context, groupID string) ([]domain.Category, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id,group_id,name,icon,active,sort_order,version FROM categories WHERE group_id=? ORDER BY sort_order,lower(name)`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	categories := make([]domain.Category, 0)
	index := map[string]int{}
	for rows.Next() {
		var item domain.Category
		if err := rows.Scan(&item.ID, &item.GroupID, &item.Name, &item.Icon, &item.Active, &item.SortOrder, &item.Version); err != nil {
			return nil, err
		}
		item.Products = make([]domain.Product, 0)
		index[item.ID] = len(categories)
		categories = append(categories, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	products, err := s.DB.QueryContext(ctx, `SELECT p.id,p.group_id,p.category_id,p.name,p.price_minor,p.pricing_mode,g.currency,p.image_key,p.active,p.sort_order,p.version
		FROM products p JOIN groups g ON g.id=p.group_id WHERE p.group_id=? ORDER BY p.sort_order,lower(p.name)`, groupID)
	if err != nil {
		return nil, err
	}
	defer products.Close()
	for products.Next() {
		var item domain.Product
		var imageKey sql.NullString
		if err := products.Scan(&item.ID, &item.GroupID, &item.CategoryID, &item.Name, &item.PriceMinor, &item.PricingMode, &item.Currency, &imageKey, &item.Active, &item.SortOrder, &item.Version); err != nil {
			return nil, err
		}
		if imageKey.Valid {
			item.ImageURL = "/api/v1/groups/" + item.GroupID + "/images/" + imageKey.String
		}
		if position, ok := index[item.CategoryID]; ok {
			categories[position].Products = append(categories[position].Products, item)
		}
	}
	return categories, products.Err()
}

// CreateCategory validates input and creates a category in membership's group.
// ctx bounds the audited transaction and actor supplies audit identity. It
// returns the Category or forbidden, validation, audit, and database errors.
func (s Service) CreateCategory(ctx context.Context, actor domain.Principal, membership domain.Membership, input CreateCategoryInput) (domain.Category, error) {
	if !groups.HasRole(membership, domain.RoleCatalogManager) {
		return domain.Category{}, domain.ErrForbidden
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len(input.Name) > 120 {
		return domain.Category{}, domain.ValidationError{Field: "name", Message: "must contain 1 to 120 characters"}
	}
	if !domain.ValidCategoryIcon(input.Icon) {
		return domain.Category{}, domain.ValidationError{Field: "icon", Message: "must be a supported category icon"}
	}
	id, _ := platform.NewID("cat")
	now := platform.Timestamp(platform.Now())
	var item domain.Category
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := tx.QueryRowContext(ctx, `SELECT coalesce(max(sort_order),-1)+1 FROM categories WHERE group_id=?`, membership.GroupID).Scan(&input.SortOrder); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO categories(id,group_id,name,icon,active,sort_order,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?)`,
			id, membership.GroupID, input.Name, input.Icon, input.SortOrder, now, now); err != nil {
			return err
		}
		item = domain.Category{ID: id, GroupID: membership.GroupID, Name: input.Name, Icon: input.Icon, Active: true, SortOrder: input.SortOrder, Version: 1, Products: []domain.Product{}}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "category.created", "category", id, input)
	})
	return item, err
}

// UpdateCategory updates categoryID in membership's group using input.Version
// for optimistic concurrency. It returns the updated Category or forbidden,
// validation, not-found, precondition, audit, and storage errors.
func (s Service) UpdateCategory(ctx context.Context, actor domain.Principal, membership domain.Membership, categoryID string, input UpdateCategoryInput) (domain.Category, error) {
	if !groups.HasRole(membership, domain.RoleCatalogManager) {
		return domain.Category{}, domain.ErrForbidden
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len(input.Name) > 120 || input.Version < 1 {
		return domain.Category{}, domain.ValidationError{Field: "category", Message: "name and version are required"}
	}
	if !domain.ValidCategoryIcon(input.Icon) {
		return domain.Category{}, domain.ValidationError{Field: "icon", Message: "must be a supported category icon"}
	}
	now := platform.Timestamp(platform.Now())
	var item domain.Category
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, `UPDATE categories SET name=?,icon=?,active=?,sort_order=?,version=version+1,updated_at=? WHERE id=? AND group_id=? AND version=?`,
			input.Name, input.Icon, input.Active, input.SortOrder, now, categoryID, membership.GroupID, input.Version)
		if err != nil {
			return err
		}
		changed, _ := result.RowsAffected()
		if changed == 0 {
			var exists int
			_ = tx.QueryRowContext(ctx, `SELECT count(*) FROM categories WHERE id=? AND group_id=?`, categoryID, membership.GroupID).Scan(&exists)
			if exists == 0 {
				return domain.ErrNotFound
			}
			return domain.ErrPrecondition
		}
		item = domain.Category{ID: categoryID, GroupID: membership.GroupID, Name: input.Name, Icon: input.Icon, Active: input.Active, SortOrder: input.SortOrder, Version: input.Version + 1, Products: []domain.Product{}}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "category.updated", "category", categoryID, input)
	})
	return item, err
}

// DeleteCategory permanently removes an archived, empty, and historically
// unused category using optimistic concurrency. Active categories, categories
// with products, and categories referenced by bookings or ledger entries return
// a conflict. Current invitation grants and membership grants are cleaned up in
// the same audited transaction. It returns forbidden, not-found, precondition,
// conflict, audit, and storage errors.
func (s Service) DeleteCategory(ctx context.Context, actor domain.Principal, membership domain.Membership, categoryID string, version int64) error {
	if !groups.HasRole(membership, domain.RoleCatalogManager) {
		return domain.ErrForbidden
	}
	if version < 1 {
		return domain.ValidationError{Field: "version", Message: "must be a positive integer"}
	}
	return storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		var item domain.Category
		if err := tx.QueryRowContext(ctx, `SELECT id,group_id,name,icon,active,sort_order,version FROM categories WHERE id=? AND group_id=?`, categoryID, membership.GroupID).
			Scan(&item.ID, &item.GroupID, &item.Name, &item.Icon, &item.Active, &item.SortOrder, &item.Version); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		if item.Version != version {
			return domain.ErrPrecondition
		}
		if item.Active {
			return fmt.Errorf("%w: category must be archived before it can be deleted", domain.ErrConflict)
		}
		var products, historicalReferences int
		if err := tx.QueryRowContext(ctx, `SELECT
			(SELECT count(*) FROM products WHERE group_id=? AND category_id=?),
			(SELECT count(*) FROM bookings WHERE group_id=? AND category_id=?) +
			(SELECT count(*) FROM ledger_entries WHERE group_id=? AND category_id=?)`,
			membership.GroupID, categoryID, membership.GroupID, categoryID, membership.GroupID, categoryID).
			Scan(&products, &historicalReferences); err != nil {
			return err
		}
		if products > 0 {
			return fmt.Errorf("%w: category still contains products that must be archived and deleted first", domain.ErrConflict)
		}
		if historicalReferences > 0 {
			return fmt.Errorf("%w: category has historical financial records and must remain archived", domain.ErrConflict)
		}
		var membershipGrants int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM category_permissions WHERE group_id=? AND category_id=?`, membership.GroupID, categoryID).Scan(&membershipGrants); err != nil {
			return err
		}
		grantPath := `$."` + categoryID + `"`
		result, err := tx.ExecContext(ctx, `UPDATE invitations SET category_grants_json=json_remove(category_grants_json, ?)
			WHERE group_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND json_type(category_grants_json, ?) IS NOT NULL`,
			grantPath, membership.GroupID, grantPath)
		if err != nil {
			return err
		}
		invitationGrants, _ := result.RowsAffected()
		deleteResult, err := tx.ExecContext(ctx, `DELETE FROM categories WHERE id=? AND group_id=? AND version=? AND active=0`, categoryID, membership.GroupID, version)
		if err != nil {
			return err
		}
		if deleted, _ := deleteResult.RowsAffected(); deleted != 1 {
			return domain.ErrPrecondition
		}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "category.deleted", "category", categoryID, map[string]any{
			"name": item.Name, "icon": item.Icon, "active": item.Active, "sortOrder": item.SortOrder, "version": item.Version,
			"removedMembershipGrants": membershipGrants, "removedInvitationGrants": invitationGrants,
		})
	})
}

// CreateProduct idempotently validates input and adds a priced item to categoryID
// in the caller's group. ctx bounds the audited transaction and idempotencyKey
// protects retries. It returns the created or replayed Product, or forbidden,
// validation, not-found, idempotency, audit, and database errors.
func (s Service) CreateProduct(ctx context.Context, actor domain.Principal, membership domain.Membership, idempotencyKey, categoryID string, input CreateProductInput) (domain.Product, error) {
	if !groups.HasRole(membership, domain.RoleCatalogManager) {
		return domain.Product{}, domain.ErrForbidden
	}
	if err := idempotency.ValidateKey(idempotencyKey); err != nil {
		return domain.Product{}, err
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len(input.Name) > 120 {
		return domain.Product{}, domain.ValidationError{Field: "name", Message: "must contain 1 to 120 characters"}
	}
	pricingMode, err := validateProductPricing(input.PricingMode, input.PriceMinor)
	if err != nil {
		return domain.Product{}, err
	}
	input.PricingMode = pricingMode
	requestHash, err := idempotency.Hash(map[string]any{"action": "product.create", "categoryId": categoryID, "input": input})
	if err != nil {
		return domain.Product{}, err
	}
	var item domain.Product
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		found, err := idempotency.Load(ctx, tx, membership.GroupID, actor.UserID, idempotencyKey, requestHash, &item)
		if err != nil || found {
			return err
		}
		var currency string
		err = tx.QueryRowContext(ctx, `SELECT g.currency FROM categories c JOIN groups g ON g.id=c.group_id WHERE c.id=? AND c.group_id=?`, categoryID, membership.GroupID).Scan(&currency)
		if errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		}
		if err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx, `SELECT coalesce(max(sort_order),-1)+1 FROM products WHERE group_id=? AND category_id=?`, membership.GroupID, categoryID).Scan(&input.SortOrder); err != nil {
			return err
		}
		id, err := platform.NewID("prd")
		if err != nil {
			return err
		}
		now := platform.Timestamp(platform.Now())
		if _, err := tx.ExecContext(ctx, `INSERT INTO products(id,group_id,category_id,name,price_minor,pricing_mode,active,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?,?)`,
			id, membership.GroupID, categoryID, input.Name, input.PriceMinor, input.PricingMode, input.SortOrder, now, now); err != nil {
			return err
		}
		item = domain.Product{ID: id, GroupID: membership.GroupID, CategoryID: categoryID, Name: input.Name, PriceMinor: input.PriceMinor, PricingMode: input.PricingMode, Currency: currency, Active: true, SortOrder: input.SortOrder, Version: 1}
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "product.created", "product", id, input); err != nil {
			return err
		}
		return idempotency.Store(ctx, tx, membership.GroupID, actor.UserID, idempotencyKey, requestHash, 201, item)
	})
	return item, err
}

// Reorder atomically replaces every category and product position in the
// caller's group. The complete-ID contract prevents stale clients from silently
// dropping newly created catalog items. It returns forbidden, validation,
// audit, and database errors.
func (s Service) Reorder(ctx context.Context, actor domain.Principal, membership domain.Membership, input ReorderInput) error {
	if !groups.HasRole(membership, domain.RoleCatalogManager) {
		return domain.ErrForbidden
	}
	if input.CategoryIDs == nil || input.ProductIDsByCategory == nil {
		return domain.ValidationError{Field: "catalogOrder", Message: "categoryIds and productIdsByCategory are required"}
	}
	if len(input.CategoryIDs) > maxCatalogOrderItems {
		return domain.ValidationError{Field: "categoryIds", Message: "contains too many categories"}
	}
	now := platform.Timestamp(platform.Now())
	return storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		categoryRows, err := tx.QueryContext(ctx, `SELECT id FROM categories WHERE group_id=?`, membership.GroupID)
		if err != nil {
			return err
		}
		existingCategories := make(map[string]struct{})
		for categoryRows.Next() {
			var categoryID string
			if err := categoryRows.Scan(&categoryID); err != nil {
				categoryRows.Close()
				return err
			}
			existingCategories[categoryID] = struct{}{}
		}
		if err := categoryRows.Err(); err != nil {
			categoryRows.Close()
			return err
		}
		if err := categoryRows.Close(); err != nil {
			return err
		}
		if len(existingCategories) != len(input.CategoryIDs) || len(input.ProductIDsByCategory) != len(existingCategories) {
			return domain.ValidationError{Field: "categoryIds", Message: "must contain every category exactly once"}
		}
		seenCategories := make(map[string]struct{}, len(input.CategoryIDs))
		for _, categoryID := range input.CategoryIDs {
			if _, exists := existingCategories[categoryID]; !exists || categoryID == "" {
				return domain.ValidationError{Field: "categoryIds", Message: "must contain every category exactly once"}
			}
			if _, duplicate := seenCategories[categoryID]; duplicate {
				return domain.ValidationError{Field: "categoryIds", Message: "must contain every category exactly once"}
			}
			if _, exists := input.ProductIDsByCategory[categoryID]; !exists {
				return domain.ValidationError{Field: "productIdsByCategory", Message: "must contain every category"}
			}
			seenCategories[categoryID] = struct{}{}
		}
		for categoryID := range input.ProductIDsByCategory {
			if _, exists := existingCategories[categoryID]; !exists {
				return domain.ValidationError{Field: "productIdsByCategory", Message: "contains an unknown category"}
			}
		}

		productRows, err := tx.QueryContext(ctx, `SELECT id,category_id FROM products WHERE group_id=?`, membership.GroupID)
		if err != nil {
			return err
		}
		existingProducts := make(map[string]string)
		for productRows.Next() {
			var productID, categoryID string
			if err := productRows.Scan(&productID, &categoryID); err != nil {
				productRows.Close()
				return err
			}
			existingProducts[productID] = categoryID
		}
		if err := productRows.Err(); err != nil {
			productRows.Close()
			return err
		}
		if err := productRows.Close(); err != nil {
			return err
		}
		if len(existingProducts) > maxCatalogOrderItems {
			return domain.ValidationError{Field: "productIdsByCategory", Message: "contains too many products"}
		}
		seenProducts := make(map[string]struct{}, len(existingProducts))
		for _, categoryID := range input.CategoryIDs {
			productIDs := input.ProductIDsByCategory[categoryID]
			if len(productIDs) > maxCatalogOrderItems {
				return domain.ValidationError{Field: "productIdsByCategory", Message: "contains too many products"}
			}
			for _, productID := range productIDs {
				owningCategory, exists := existingProducts[productID]
				if !exists || owningCategory != categoryID || productID == "" {
					return domain.ValidationError{Field: "productIdsByCategory", Message: "must contain every product in its owning category"}
				}
				if _, duplicate := seenProducts[productID]; duplicate {
					return domain.ValidationError{Field: "productIdsByCategory", Message: "must contain every product exactly once"}
				}
				seenProducts[productID] = struct{}{}
			}
		}
		if len(seenProducts) != len(existingProducts) {
			return domain.ValidationError{Field: "productIdsByCategory", Message: "must contain every product exactly once"}
		}

		for position, categoryID := range input.CategoryIDs {
			if _, err := tx.ExecContext(ctx, `UPDATE categories SET sort_order=?,version=version+1,updated_at=? WHERE id=? AND group_id=? AND sort_order<>?`, position, now, categoryID, membership.GroupID, position); err != nil {
				return err
			}
			for productPosition, productID := range input.ProductIDsByCategory[categoryID] {
				if _, err := tx.ExecContext(ctx, `UPDATE products SET sort_order=?,version=version+1,updated_at=? WHERE id=? AND group_id=? AND category_id=? AND sort_order<>?`, productPosition, now, productID, membership.GroupID, categoryID, productPosition); err != nil {
					return err
				}
			}
		}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "catalog.reordered", "catalog", membership.GroupID, input)
	})
}

// UpdateProduct updates mutable data for productID using input.Version without
// affecting historical booking snapshots. It returns the updated Product or
// forbidden, validation, not-found, precondition, audit, and storage errors.
func (s Service) UpdateProduct(ctx context.Context, actor domain.Principal, membership domain.Membership, productID string, input UpdateProductInput) (domain.Product, error) {
	if !groups.HasRole(membership, domain.RoleCatalogManager) {
		return domain.Product{}, domain.ErrForbidden
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len(input.Name) > 120 || input.Version < 1 {
		return domain.Product{}, domain.ValidationError{Field: "product", Message: "valid name and version are required"}
	}
	pricingMode, err := validateProductPricing(input.PricingMode, input.PriceMinor)
	if err != nil {
		return domain.Product{}, err
	}
	input.PricingMode = pricingMode
	now := platform.Timestamp(platform.Now())
	var item domain.Product
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, `UPDATE products SET name=?,price_minor=?,pricing_mode=?,active=?,sort_order=?,version=version+1,updated_at=? WHERE id=? AND group_id=? AND version=?`,
			input.Name, input.PriceMinor, input.PricingMode, input.Active, input.SortOrder, now, productID, membership.GroupID, input.Version)
		if err != nil {
			return err
		}
		changed, _ := result.RowsAffected()
		if changed == 0 {
			var exists int
			_ = tx.QueryRowContext(ctx, `SELECT count(*) FROM products WHERE id=? AND group_id=?`, productID, membership.GroupID).Scan(&exists)
			if exists == 0 {
				return domain.ErrNotFound
			}
			return domain.ErrPrecondition
		}
		var categoryID, currency string
		if err := tx.QueryRowContext(ctx, `SELECT p.category_id,g.currency FROM products p JOIN groups g ON g.id=p.group_id WHERE p.id=?`, productID).Scan(&categoryID, &currency); err != nil {
			return err
		}
		item = domain.Product{ID: productID, GroupID: membership.GroupID, CategoryID: categoryID, Name: input.Name, PriceMinor: input.PriceMinor, PricingMode: input.PricingMode, Currency: currency, Active: input.Active, SortOrder: input.SortOrder, Version: input.Version + 1}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "product.updated", "product", productID, input)
	})
	return item, err
}

// DeleteProduct permanently removes an archived product that has never been
// booked, using optimistic concurrency. Any booking, including a voided one,
// preserves the product as historical catalog data and returns a conflict.
// Stale idempotency replays for the deleted product are removed atomically. It
// returns forbidden, not-found, precondition, conflict, audit, and storage errors.
func (s Service) DeleteProduct(ctx context.Context, actor domain.Principal, membership domain.Membership, productID string, version int64) error {
	if !groups.HasRole(membership, domain.RoleCatalogManager) {
		return domain.ErrForbidden
	}
	if version < 1 {
		return domain.ValidationError{Field: "version", Message: "must be a positive integer"}
	}
	return storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		var item domain.Product
		var imageKey sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT p.id,p.group_id,p.category_id,p.name,p.price_minor,p.pricing_mode,g.currency,p.image_key,p.active,p.sort_order,p.version
			FROM products p JOIN groups g ON g.id=p.group_id WHERE p.id=? AND p.group_id=?`, productID, membership.GroupID).
			Scan(&item.ID, &item.GroupID, &item.CategoryID, &item.Name, &item.PriceMinor, &item.PricingMode, &item.Currency, &imageKey, &item.Active, &item.SortOrder, &item.Version); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		if item.Version != version {
			return domain.ErrPrecondition
		}
		if item.Active {
			return fmt.Errorf("%w: product must be archived before it can be deleted", domain.ErrConflict)
		}
		var bookings int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM bookings WHERE group_id=? AND product_id=?`, membership.GroupID, productID).Scan(&bookings); err != nil {
			return err
		}
		if bookings > 0 {
			return fmt.Errorf("%w: product has historical bookings and must remain archived", domain.ErrConflict)
		}
		deleteResult, err := tx.ExecContext(ctx, `DELETE FROM products WHERE id=? AND group_id=? AND version=? AND active=0`, productID, membership.GroupID, version)
		if err != nil {
			return err
		}
		if deleted, _ := deleteResult.RowsAffected(); deleted != 1 {
			return domain.ErrPrecondition
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM idempotency_results WHERE group_id=? AND json_extract(response_json,'$.id')=?`, membership.GroupID, productID); err != nil {
			return err
		}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "product.deleted", "product", productID, map[string]any{
			"categoryId": item.CategoryID, "name": item.Name, "priceMinor": item.PriceMinor, "pricingMode": item.PricingMode,
			"imageKey": imageKey.String, "active": item.Active, "sortOrder": item.SortOrder, "version": item.Version,
		})
	})
}

// validateProductPricing normalizes legacy fixed-price commands and validates
// the mode-specific price contract. pricingMode may be omitted only when a
// legacy fixed price is present. It returns the normalized mode or a safe
// validation error.
func validateProductPricing(pricingMode domain.ProductPricingMode, priceMinor *int64) (domain.ProductPricingMode, error) {
	if pricingMode == "" && priceMinor != nil {
		pricingMode = domain.ProductPricingFixed
	}
	switch pricingMode {
	case domain.ProductPricingFixed:
		if priceMinor == nil || *priceMinor <= 0 || *priceMinor > domain.MaxProductPriceMinor {
			return "", domain.ValidationError{Field: "priceMinor", Message: "must be a positive, reasonable integer for fixed-price products"}
		}
	case domain.ProductPricingUserDefined:
		if priceMinor != nil {
			return "", domain.ValidationError{Field: "priceMinor", Message: "must be omitted for user-defined-price products"}
		}
	default:
		return "", domain.ValidationError{Field: "pricingMode", Message: "must be FIXED or USER_DEFINED"}
	}
	return pricingMode, nil
}

// SetProductImage attaches imageKey to productID in membership's group. ctx
// bounds the audited transaction; actor supplies audit identity. It returns the
// public URL and replaced image key for later offline maintenance, or forbidden,
// not-found, audit, and database errors. Request paths must not delete content
// hashes because a concurrent transaction may begin referencing them.
func (s Service) SetProductImage(ctx context.Context, actor domain.Principal, membership domain.Membership, productID, imageKey string) (string, string, error) {
	if !groups.HasRole(membership, domain.RoleCatalogManager) {
		return "", "", domain.ErrForbidden
	}
	if !media.ValidImageKey(imageKey) {
		return "", "", domain.ValidationError{Field: "image", Message: "has an invalid storage key"}
	}
	var replacedKey string
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		var previous sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT image_key FROM products WHERE id=? AND group_id=?`, productID, membership.GroupID).Scan(&previous); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		replacedKey = previous.String
		result, err := tx.ExecContext(ctx, `UPDATE products SET image_key=?,version=version+1,updated_at=? WHERE id=? AND group_id=?`, imageKey, platform.Timestamp(platform.Now()), productID, membership.GroupID)
		if err != nil {
			return err
		}
		changed, _ := result.RowsAffected()
		if changed == 0 {
			return domain.ErrNotFound
		}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "product.image.updated", "product", productID, map[string]any{"imageKey": imageKey})
	})
	return "/api/v1/groups/" + membership.GroupID + "/images/" + imageKey, replacedKey, err
}

// ProductCategory returns productID's owning category within groupID for
// cross-resource authorization. ctx bounds the lookup; missing or cross-tenant
// products return ErrNotFound and other SQL failures are wrapped.
func (s Service) ProductCategory(ctx context.Context, groupID, productID string) (string, error) {
	var categoryID string
	if err := s.DB.QueryRowContext(ctx, `SELECT category_id FROM products WHERE group_id=? AND id=?`, groupID, productID).Scan(&categoryID); errors.Is(err, sql.ErrNoRows) {
		return "", domain.ErrNotFound
	} else if err != nil {
		return "", fmt.Errorf("resolve product: %w", err)
	}
	return categoryID, nil
}
