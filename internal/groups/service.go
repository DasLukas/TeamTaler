// Package groups implements group membership, roles, invitations, and isolation checks.
package groups

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/DasLukas/TeamTaler/internal/audit"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/media"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

var (
	// ErrMembershipEmailExists identifies an address already attached to a
	// membership in the target group.
	ErrMembershipEmailExists = errors.New("a membership already exists for this email address")
	// ErrInvitationEmailExists identifies an address with a current, unconsumed
	// invitation in the target group.
	ErrInvitationEmailExists = errors.New("an active invitation already exists for this email address")
)

const activeInvitationEmailConstraint = "teamtaler_active_invitation_email_exists"

// Service provides authorization-aware group operations over a migrated
// TeamTaler database.
type Service struct {
	// DB is the shared application database connection pool.
	DB *sql.DB
	// TokenSealer encrypts invitation tokens before durable email delivery.
	// It may be nil when outbound invitation email is disabled.
	TokenSealer TokenSealer
	// TokenOpener restores an administrator-visible public join-link token from
	// authenticated ciphertext. It may be nil when outbound email is disabled.
	TokenOpener TokenOpener
	// EmailDeliveryAvailable reports whether verified public registration can
	// deliver its mandatory confirmation message.
	EmailDeliveryAvailable bool
}

// Create creates a group, its initial period, and an administrator membership
// for actor. ctx bounds the transaction; name and currency are validated. It
// returns the new Group or validation, storage, and audit errors.
func (s Service) Create(ctx context.Context, actor domain.Principal, name, currency string) (domain.Group, error) {
	name = strings.TrimSpace(name)
	currency = strings.ToUpper(strings.TrimSpace(currency))
	if name == "" || len(name) > 120 || containsControlCharacter(name) {
		return domain.Group{}, domain.ValidationError{Field: "name", Message: "must contain 1 to 120 characters without control characters"}
	}
	if !platform.IsCurrencyCode(currency) {
		return domain.Group{}, domain.ValidationError{Field: "currency", Message: "must be a three-letter ISO 4217 code"}
	}
	groupID, _ := platform.NewID("grp")
	membershipID, _ := platform.NewID("mem")
	periodID, _ := platform.NewID("per")
	nowValue := platform.Now()
	now := platform.Timestamp(nowValue)
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES(?,?,?,?,?)`, groupID, name, currency, now, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO group_settings(group_id,members_can_view_all_bookings,default_role_id,updated_at) VALUES(?,0,?,?)`, groupID, authorization.GuestRoleID(groupID), now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES(?,?,?,'ACTIVE',?)`, membershipID, groupID, actor.UserID, now); err != nil {
			return err
		}
		if err := authorization.SeedGroupRoles(ctx, tx, groupID, actor.UserID, membershipID, nowValue); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO membership_roles(group_id,membership_id,role,granted_at,granted_by) VALUES(?,?,'ADMIN',?,?)`, groupID, membershipID, now, actor.UserID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO periods(id,group_id,label,status,starts_at,created_at) VALUES(?,?,?,'OPEN',?,?)`, periodID, groupID, domain.DefaultOpenPeriodLabel, now, now); err != nil {
			return err
		}
		return audit.Record(ctx, tx, groupID, actor.UserID, membershipID, "group.created", "group", groupID, map[string]any{"name": name, "currency": currency})
	})
	if err != nil {
		return domain.Group{}, fmt.Errorf("create group: %w", err)
	}
	group := domain.Group{ID: groupID, Name: name, Currency: currency, Membership: domain.Membership{
		ID: membershipID, GroupID: groupID, UserID: actor.UserID, Email: &actor.Email, DisplayName: actor.DisplayName, AvatarURL: actor.AvatarURL, Status: "ACTIVE", Roles: []domain.Role{domain.RoleAdmin}, GroupPermissions: []domain.GroupPermission{}, CategoryGrants: map[string][]domain.CategoryPermission{},
	}}
	if err := s.hydrateMembershipAuthorization(ctx, &group.Membership); err != nil {
		return domain.Group{}, err
	}
	return group, nil
}

// List returns all active groups and effective permissions for userID. ctx
// bounds the query; an empty result is valid, while database errors are returned.
func (s Service) List(ctx context.Context, userID string) ([]domain.Group, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT g.id,g.name,g.currency,g.logo_key,m.id,m.status,u.email,u.display_name,u.avatar_key
		FROM memberships m JOIN groups g ON g.id=m.group_id JOIN users u ON u.id=m.user_id
		WHERE m.user_id=? AND m.status='ACTIVE' AND g.status='ACTIVE' ORDER BY lower(g.name)`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.Group, 0)
	for rows.Next() {
		var group domain.Group
		var logoKey, avatarKey sql.NullString
		group.Membership.UserID = userID
		if err := rows.Scan(&group.ID, &group.Name, &group.Currency, &logoKey, &group.Membership.ID, &group.Membership.Status, &group.Membership.Email, &group.Membership.DisplayName, &avatarKey); err != nil {
			return nil, err
		}
		if logoKey.Valid {
			group.LogoURL = "/api/v1/groups/" + group.ID + "/images/" + logoKey.String
		}
		group.Membership.GroupID = group.ID
		group.Membership.AvatarURL = media.UserAvatarURL(userID, avatarKey.String)
		result = append(result, group)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for index := range result {
		if err = s.hydrateMembershipAuthorization(ctx, &result[index].Membership); err != nil {
			return nil, err
		}
	}
	return result, nil
}

// UpdateName validates and changes the current group's display name. Only
// administrators may rename a group. ctx bounds the atomic name and audit
// update; actor and membership scope authorization and attribution. It returns
// the normalized name or validation, authorization, not-found, audit, and
// database errors.
func (s Service) UpdateName(ctx context.Context, actor domain.Principal, membership domain.Membership, name string) (string, error) {
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionGroupAdministration); err != nil {
		return "", err
	}
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 120 || containsControlCharacter(name) {
		return "", domain.ValidationError{Field: "name", Message: "must contain 1 to 120 characters without control characters"}
	}
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, membership, domain.PermissionGroupAdministration); err != nil {
			return err
		}
		var previousName string
		if err := tx.QueryRowContext(ctx, `SELECT name FROM groups WHERE id=?`, membership.GroupID).Scan(&previousName); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		if previousName == name {
			return nil
		}
		if _, err := tx.ExecContext(ctx, `UPDATE groups SET name=?,updated_at=? WHERE id=?`, name, platform.Timestamp(platform.Now()), membership.GroupID); err != nil {
			return err
		}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "group.name.updated", "group", membership.GroupID, map[string]any{"previousName": previousName, "name": name})
	})
	if err != nil {
		return "", err
	}
	return name, nil
}

// Settings returns the current group's typed behavior settings. Group and
// member managers may read the shared resource; field-level authorization is
// enforced separately for updates.
func (s Service) Settings(ctx context.Context, membership domain.Membership) (domain.GroupSettings, error) {
	if err := requireAnyCurrentPermission(ctx, s.DB, membership, domain.PermissionGroupAdministration, domain.PermissionMemberManagement); err != nil {
		return domain.GroupSettings{}, err
	}
	return s.settingsForGroup(ctx, membership.GroupID)
}

// SettingsUpdate describes a partial change to group behavior.
type SettingsUpdate struct {
	NotificationEmailsEnabled    *bool
	SettlementsEnabled           *bool
	DefaultRoleID                *string
	OwnBookingReasonMode         *domain.ReasonMode
	ForeignBookingReasonMode     *domain.ReasonMode
	OwnPaymentReasonMode         *domain.ReasonMode
	OtherPaymentReasonMode       *domain.ReasonMode
	ForeignBookingReasonRequired *bool
	OwnPaymentReasonRequired     *bool
	OtherPaymentReasonRequired   *bool
	PaymentMethods               *[]domain.ConfigurableItem
	BookingReasons               *[]domain.ConfigurableItem
	PaymentReasons               *[]domain.ConfigurableItem
}

// UpdateSettings atomically applies the supplied group-wide behavior changes.
// MEMBER_MANAGEMENT protects the default role; GROUP_ADMINISTRATION protects
// every technical and behavioral field. Mixed updates require both rights.
func (s Service) UpdateSettings(ctx context.Context, actor domain.Principal, membership domain.Membership, update SettingsUpdate) (domain.GroupSettings, error) {
	if update.NotificationEmailsEnabled == nil && update.SettlementsEnabled == nil && update.DefaultRoleID == nil &&
		update.OwnBookingReasonMode == nil && update.ForeignBookingReasonMode == nil &&
		update.OwnPaymentReasonMode == nil && update.OtherPaymentReasonMode == nil &&
		update.ForeignBookingReasonRequired == nil && update.OwnPaymentReasonRequired == nil &&
		update.OtherPaymentReasonRequired == nil && update.PaymentMethods == nil &&
		update.BookingReasons == nil && update.PaymentReasons == nil {
		return domain.GroupSettings{}, domain.ValidationError{Field: "settings", Message: "must contain at least one supported field"}
	}
	if update.DefaultRoleID != nil {
		trimmed := strings.TrimSpace(*update.DefaultRoleID)
		if trimmed == "" {
			return domain.GroupSettings{}, domain.ValidationError{Field: "defaultRoleId", Message: "is required"}
		}
		update.DefaultRoleID = &trimmed
	}
	if err := validateReasonModeUpdates(update); err != nil {
		return domain.GroupSettings{}, err
	}
	if err := requireSettingsUpdatePermissions(ctx, s.DB, membership, update); err != nil {
		return domain.GroupSettings{}, err
	}
	var persisted domain.GroupSettings
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireSettingsUpdatePermissions(ctx, tx, membership, update); err != nil {
			return err
		}
		var previous domain.GroupSettings
		if err := querySettings(ctx, tx, membership.GroupID, &previous); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		next := previous
		if update.NotificationEmailsEnabled != nil {
			next.NotificationEmailsEnabled = *update.NotificationEmailsEnabled
		}
		if update.SettlementsEnabled != nil {
			next.SettlementsEnabled = *update.SettlementsEnabled
		}
		if update.DefaultRoleID != nil {
			if err := validateDefaultRole(ctx, tx, membership.GroupID, *update.DefaultRoleID); err != nil {
				return err
			}
			next.DefaultRoleID = update.DefaultRoleID
		}
		if update.OwnBookingReasonMode != nil {
			next.OwnBookingReasonMode = *update.OwnBookingReasonMode
		}
		if update.ForeignBookingReasonMode != nil {
			next.ForeignBookingReasonMode = *update.ForeignBookingReasonMode
		} else if update.ForeignBookingReasonRequired != nil {
			next.ForeignBookingReasonMode = reasonModeFromLegacyRequired(*update.ForeignBookingReasonRequired)
		}
		if update.OwnPaymentReasonMode != nil {
			next.OwnPaymentReasonMode = *update.OwnPaymentReasonMode
		} else if update.OwnPaymentReasonRequired != nil {
			next.OwnPaymentReasonMode = reasonModeFromLegacyRequired(*update.OwnPaymentReasonRequired)
		}
		if update.OtherPaymentReasonMode != nil {
			next.OtherPaymentReasonMode = *update.OtherPaymentReasonMode
		} else if update.OtherPaymentReasonRequired != nil {
			next.OtherPaymentReasonMode = reasonModeFromLegacyRequired(*update.OtherPaymentReasonRequired)
		}
		if update.ForeignBookingReasonRequired != nil && update.ForeignBookingReasonMode == nil {
			next.ForeignBookingReasonRequired = *update.ForeignBookingReasonRequired
		}
		if update.OwnPaymentReasonRequired != nil && update.OwnPaymentReasonMode == nil {
			next.OwnPaymentReasonRequired = *update.OwnPaymentReasonRequired
		}
		if update.OtherPaymentReasonRequired != nil && update.OtherPaymentReasonMode == nil {
			next.OtherPaymentReasonRequired = *update.OtherPaymentReasonRequired
		}
		next.ForeignBookingReasonRequired = next.ForeignBookingReasonMode.Required()
		next.OwnPaymentReasonRequired = next.OwnPaymentReasonMode.Required()
		next.OtherPaymentReasonRequired = next.OtherPaymentReasonMode.Required()
		var err error
		if update.PaymentMethods != nil {
			next.PaymentMethods, err = normalizeConfigurableItems(*update.PaymentMethods, "paymentMethods", 1, 20)
			if err != nil {
				return err
			}
		}
		if update.BookingReasons != nil {
			next.BookingReasons, err = normalizeConfigurableItems(*update.BookingReasons, "bookingReasons", 0, 50)
			if err != nil {
				return err
			}
		}
		if update.PaymentReasons != nil {
			next.PaymentReasons, err = normalizeConfigurableItems(*update.PaymentReasons, "paymentReasons", 0, 50)
			if err != nil {
				return err
			}
		}
		if groupSettingsEqual(previous, next) {
			persisted = previous
			return nil
		}
		now := platform.Timestamp(platform.Now())
		if _, err := tx.ExecContext(ctx, `UPDATE group_settings SET notification_emails_enabled=?,settlements_enabled=?,default_role_id=?,
			own_booking_reason_mode=?,foreign_booking_reason_mode=?,own_payment_reason_mode=?,other_payment_reason_mode=?,
			foreign_booking_reason_required=?,own_payment_reason_required=?,other_payment_reason_required=?,updated_at=? WHERE group_id=?`,
			next.NotificationEmailsEnabled, next.SettlementsEnabled, nullableText(next.DefaultRoleID), next.OwnBookingReasonMode,
			next.ForeignBookingReasonMode, next.OwnPaymentReasonMode, next.OtherPaymentReasonMode, next.ForeignBookingReasonRequired,
			next.OwnPaymentReasonRequired, next.OtherPaymentReasonRequired, now, membership.GroupID); err != nil {
			return err
		}
		if update.PaymentMethods != nil {
			if err := replaceConfiguredItems(ctx, tx, membership.GroupID, "PAYMENT_METHOD", next.PaymentMethods, now); err != nil {
				return err
			}
		}
		if update.BookingReasons != nil {
			if err := replaceConfiguredItems(ctx, tx, membership.GroupID, "BOOKING", next.BookingReasons, now); err != nil {
				return err
			}
		}
		if update.PaymentReasons != nil {
			if err := replaceConfiguredItems(ctx, tx, membership.GroupID, "PAYMENT", next.PaymentReasons, now); err != nil {
				return err
			}
		}
		if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "group.settings.updated", "group", membership.GroupID, map[string]any{
			"notificationEmailsEnabled": map[string]bool{"previous": previous.NotificationEmailsEnabled, "current": next.NotificationEmailsEnabled},
			"settlementsEnabled":        map[string]bool{"previous": previous.SettlementsEnabled, "current": next.SettlementsEnabled},
			"defaultRoleId":             map[string]any{"previous": previous.DefaultRoleID, "current": next.DefaultRoleID},
			"transactionSettings": map[string]any{
				"ownBookingReasonMode":         next.OwnBookingReasonMode,
				"foreignBookingReasonMode":     next.ForeignBookingReasonMode,
				"ownPaymentReasonMode":         next.OwnPaymentReasonMode,
				"otherPaymentReasonMode":       next.OtherPaymentReasonMode,
				"foreignBookingReasonRequired": next.ForeignBookingReasonRequired,
				"ownPaymentReasonRequired":     next.OwnPaymentReasonRequired,
				"otherPaymentReasonRequired":   next.OtherPaymentReasonRequired,
				"paymentMethodCount":           len(next.PaymentMethods), "bookingReasonCount": len(next.BookingReasons), "paymentReasonCount": len(next.PaymentReasons),
			},
		}); err != nil {
			return err
		}
		return querySettings(ctx, tx, membership.GroupID, &persisted)
	})
	return persisted, err
}

func requireSettingsUpdatePermissions(ctx context.Context, queryer authorization.Queryer, membership domain.Membership, update SettingsUpdate) error {
	if update.DefaultRoleID != nil {
		if err := requireCurrentPermission(ctx, queryer, membership, domain.PermissionMemberManagement); err != nil {
			return err
		}
	}
	updatesGroupConfiguration := update.NotificationEmailsEnabled != nil || update.SettlementsEnabled != nil ||
		update.OwnBookingReasonMode != nil || update.ForeignBookingReasonMode != nil ||
		update.OwnPaymentReasonMode != nil || update.OtherPaymentReasonMode != nil ||
		update.ForeignBookingReasonRequired != nil || update.OwnPaymentReasonRequired != nil ||
		update.OtherPaymentReasonRequired != nil || update.PaymentMethods != nil ||
		update.BookingReasons != nil || update.PaymentReasons != nil
	if updatesGroupConfiguration {
		return requireCurrentPermission(ctx, queryer, membership, domain.PermissionGroupAdministration)
	}
	return nil
}

func (s Service) settingsForGroup(ctx context.Context, groupID string) (domain.GroupSettings, error) {
	var settings domain.GroupSettings
	err := querySettings(ctx, s.DB, groupID, &settings)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.GroupSettings{}, domain.ErrNotFound
	}
	return settings, err
}

type settingsQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func querySettings(ctx context.Context, queryer settingsQueryer, groupID string, settings *domain.GroupSettings) error {
	var defaultRoleID sql.NullString
	if err := queryer.QueryRowContext(ctx, `SELECT notification_emails_enabled,settlements_enabled,default_role_id,
		own_booking_reason_mode,foreign_booking_reason_mode,own_payment_reason_mode,other_payment_reason_mode,
		foreign_booking_reason_required,own_payment_reason_required,other_payment_reason_required
		FROM group_settings WHERE group_id=?`, groupID).
		Scan(&settings.NotificationEmailsEnabled, &settings.SettlementsEnabled, &defaultRoleID, &settings.OwnBookingReasonMode,
			&settings.ForeignBookingReasonMode, &settings.OwnPaymentReasonMode, &settings.OtherPaymentReasonMode, &settings.ForeignBookingReasonRequired,
			&settings.OwnPaymentReasonRequired, &settings.OtherPaymentReasonRequired); err != nil {
		return err
	}
	settings.DefaultRoleID = nil
	if defaultRoleID.Valid {
		settings.DefaultRoleID = &defaultRoleID.String
	}
	var err error
	if settings.PaymentMethods, err = queryConfiguredItems(ctx, queryer, groupID, "PAYMENT_METHOD"); err != nil {
		return err
	}
	if settings.BookingReasons, err = queryConfiguredItems(ctx, queryer, groupID, "BOOKING"); err != nil {
		return err
	}
	if settings.PaymentReasons, err = queryConfiguredItems(ctx, queryer, groupID, "PAYMENT"); err != nil {
		return err
	}
	return nil
}

// TransactionSettings returns non-sensitive feature state plus booking and
// payment form options for an active group member.
func (s Service) TransactionSettings(ctx context.Context, membership domain.Membership) (domain.TransactionSettings, error) {
	var active bool
	if err := s.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM memberships WHERE group_id=? AND id=? AND status='ACTIVE' AND deleted_at IS NULL)`, membership.GroupID, membership.ID).Scan(&active); err != nil {
		return domain.TransactionSettings{}, err
	}
	if !active {
		return domain.TransactionSettings{}, domain.ErrForbidden
	}
	settings, err := s.settingsForGroup(ctx, membership.GroupID)
	if err != nil {
		return domain.TransactionSettings{}, err
	}
	return transactionSettingsFromGroup(settings), nil
}

func transactionSettingsFromGroup(settings domain.GroupSettings) domain.TransactionSettings {
	return domain.TransactionSettings{
		SettlementsEnabled:           settings.SettlementsEnabled,
		OwnBookingReasonMode:         settings.OwnBookingReasonMode,
		ForeignBookingReasonMode:     settings.ForeignBookingReasonMode,
		OwnPaymentReasonMode:         settings.OwnPaymentReasonMode,
		OtherPaymentReasonMode:       settings.OtherPaymentReasonMode,
		ForeignBookingReasonRequired: settings.ForeignBookingReasonRequired,
		OwnPaymentReasonRequired:     settings.OwnPaymentReasonRequired,
		OtherPaymentReasonRequired:   settings.OtherPaymentReasonRequired,
		PaymentMethods:               settings.PaymentMethods,
		BookingReasons:               settings.BookingReasons,
		PaymentReasons:               settings.PaymentReasons,
	}
}

func queryConfiguredItems(ctx context.Context, queryer settingsQueryer, groupID, kind string) ([]domain.ConfigurableItem, error) {
	query := `SELECT id,label FROM group_reason_suggestions WHERE group_id=? AND kind=? ORDER BY sort_order,id`
	args := []any{groupID, kind}
	if kind == "PAYMENT_METHOD" {
		query = `SELECT id,label FROM group_payment_methods WHERE group_id=? ORDER BY sort_order,id`
		args = []any{groupID}
	}
	rows, err := queryer.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.ConfigurableItem, 0)
	for rows.Next() {
		var item domain.ConfigurableItem
		if err := rows.Scan(&item.ID, &item.Label); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func normalizeConfigurableItems(items []domain.ConfigurableItem, field string, minimum, maximum int) ([]domain.ConfigurableItem, error) {
	if len(items) < minimum || len(items) > maximum {
		return nil, domain.ValidationError{Field: field, Message: fmt.Sprintf("must contain between %d and %d items", minimum, maximum)}
	}
	result := make([]domain.ConfigurableItem, 0, len(items))
	ids, labels := map[string]struct{}{}, map[string]struct{}{}
	for _, item := range items {
		item.ID, item.Label = strings.TrimSpace(item.ID), strings.TrimSpace(item.Label)
		if item.ID == "" {
			item.ID, _ = platform.NewID("opt")
		}
		if len(item.ID) > 120 || containsControlCharacter(item.ID) {
			return nil, domain.ValidationError{Field: field, Message: "contains an invalid identifier"}
		}
		if utf8.RuneCountInString(item.Label) < 1 || utf8.RuneCountInString(item.Label) > 120 || containsControlCharacter(item.Label) {
			return nil, domain.ValidationError{Field: field, Message: "contains a label outside 1 to 120 characters"}
		}
		labelKey := strings.ToLower(item.Label)
		if _, exists := ids[item.ID]; exists {
			return nil, domain.ValidationError{Field: field, Message: "contains duplicate identifiers"}
		}
		if _, exists := labels[labelKey]; exists {
			return nil, domain.ValidationError{Field: field, Message: "contains duplicate labels ignoring letter case"}
		}
		ids[item.ID], labels[labelKey] = struct{}{}, struct{}{}
		result = append(result, item)
	}
	return result, nil
}

type settingsExecutor interface {
	settingsQueryer
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func replaceConfiguredItems(ctx context.Context, queryer settingsExecutor, groupID, kind string, items []domain.ConfigurableItem, now string) error {
	if kind == "PAYMENT_METHOD" {
		if _, err := queryer.ExecContext(ctx, `DELETE FROM group_payment_methods WHERE group_id=?`, groupID); err != nil {
			return err
		}
		for index, item := range items {
			if _, err := queryer.ExecContext(ctx, `INSERT INTO group_payment_methods(group_id,id,label,sort_order,created_at) VALUES(?,?,?,?,?)`, groupID, item.ID, item.Label, index, now); err != nil {
				return err
			}
		}
		return nil
	}
	if _, err := queryer.ExecContext(ctx, `DELETE FROM group_reason_suggestions WHERE group_id=? AND kind=?`, groupID, kind); err != nil {
		return err
	}
	for index, item := range items {
		if _, err := queryer.ExecContext(ctx, `INSERT INTO group_reason_suggestions(group_id,id,kind,label,sort_order,created_at) VALUES(?,?,?,?,?,?)`, groupID, item.ID, kind, item.Label, index, now); err != nil {
			return err
		}
	}
	return nil
}

func groupSettingsEqual(left, right domain.GroupSettings) bool {
	return left.NotificationEmailsEnabled == right.NotificationEmailsEnabled && left.SettlementsEnabled == right.SettlementsEnabled && nullableStringsEqual(left.DefaultRoleID, right.DefaultRoleID) &&
		left.OwnBookingReasonMode == right.OwnBookingReasonMode && left.ForeignBookingReasonMode == right.ForeignBookingReasonMode &&
		left.OwnPaymentReasonMode == right.OwnPaymentReasonMode && left.OtherPaymentReasonMode == right.OtherPaymentReasonMode &&
		left.ForeignBookingReasonRequired == right.ForeignBookingReasonRequired && left.OwnPaymentReasonRequired == right.OwnPaymentReasonRequired &&
		left.OtherPaymentReasonRequired == right.OtherPaymentReasonRequired && reflect.DeepEqual(left.PaymentMethods, right.PaymentMethods) &&
		reflect.DeepEqual(left.BookingReasons, right.BookingReasons) && reflect.DeepEqual(left.PaymentReasons, right.PaymentReasons)
}

// validateReasonModeUpdates rejects unknown values before the settings command
// performs authorization or opens a write transaction.
func validateReasonModeUpdates(update SettingsUpdate) error {
	fields := []struct {
		name string
		mode *domain.ReasonMode
	}{
		{name: "ownBookingReasonMode", mode: update.OwnBookingReasonMode},
		{name: "foreignBookingReasonMode", mode: update.ForeignBookingReasonMode},
		{name: "ownPaymentReasonMode", mode: update.OwnPaymentReasonMode},
		{name: "otherPaymentReasonMode", mode: update.OtherPaymentReasonMode},
	}
	for _, field := range fields {
		if field.mode != nil && !field.mode.Valid() {
			return domain.ValidationError{Field: field.name, Message: "must be OFF, OPTIONAL, or REQUIRED"}
		}
	}
	return nil
}

// reasonModeFromLegacyRequired maps the deprecated Boolean setting to the two
// states expressible by legacy clients.
func reasonModeFromLegacyRequired(required bool) domain.ReasonMode {
	if required {
		return domain.ReasonModeRequired
	}
	return domain.ReasonModeOptional
}

func validateDefaultRole(ctx context.Context, queryer settingsQueryer, groupID, roleID string) error {
	var exists, grantsManagement bool
	err := queryer.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1 FROM roles WHERE group_id=? AND id=?
	), EXISTS(
		SELECT 1 FROM roles role
		JOIN role_permission_grants grant_row
		  ON grant_row.group_id=role.group_id AND grant_row.role_id=role.id
		WHERE role.group_id=? AND role.id=?
		  AND grant_row.permission_key IN ('GROUP_ADMINISTRATION','MEMBER_MANAGEMENT') AND grant_row.scope_type='GROUP'
	)`, groupID, roleID, groupID, roleID).Scan(&exists, &grantsManagement)
	if err != nil {
		return err
	}
	if !exists {
		return domain.ValidationError{Field: "defaultRoleId", Message: "contains an unknown role"}
	}
	if grantsManagement {
		return domain.ValidationError{Field: "defaultRoleId", Message: "must not grant GROUP_ADMINISTRATION or MEMBER_MANAGEMENT"}
	}
	return nil
}

func nullableText(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableStringsEqual(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

// SetLogo attaches imageKey to membership's group. Only administrators may
// update group branding. ctx bounds the audited transaction and actor supplies
// audit identity. It returns the authenticated image URL, the replaced key for
// later offline maintenance, or a validation, authorization, audit, or database
// error. Request paths must not delete replaced content hashes because another
// database row may still reference them.
func (s Service) SetLogo(ctx context.Context, actor domain.Principal, membership domain.Membership, imageKey string) (string, string, error) {
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionGroupAdministration); err != nil {
		return "", "", err
	}
	if !media.ValidImageKey(imageKey) {
		return "", "", domain.ValidationError{Field: "image", Message: "has an invalid storage key"}
	}
	var replacedKey string
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, membership, domain.PermissionGroupAdministration); err != nil {
			return err
		}
		var previous sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT logo_key FROM groups WHERE id=?`, membership.GroupID).Scan(&previous); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		replacedKey = previous.String
		if _, err := tx.ExecContext(ctx, `UPDATE groups SET logo_key=?,updated_at=? WHERE id=?`, imageKey, platform.Timestamp(platform.Now()), membership.GroupID); err != nil {
			return err
		}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "group.logo.updated", "group", membership.GroupID, map[string]any{"imageKey": imageKey})
	})
	return "/api/v1/groups/" + membership.GroupID + "/images/" + imageKey, replacedKey, err
}

// RemoveLogo clears the custom logo from membership's group so clients return
// to the TeamTaler mark. Only administrators may remove group branding. ctx
// bounds the audited transaction; actor supplies audit identity. It returns the
// detached key for later offline maintenance or an authorization, not-found,
// audit, or database error.
func (s Service) RemoveLogo(ctx context.Context, actor domain.Principal, membership domain.Membership) (string, error) {
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionGroupAdministration); err != nil {
		return "", err
	}
	var removedKey string
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, membership, domain.PermissionGroupAdministration); err != nil {
			return err
		}
		var previous sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT logo_key FROM groups WHERE id=?`, membership.GroupID).Scan(&previous); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		removedKey = previous.String
		if _, err := tx.ExecContext(ctx, `UPDATE groups SET logo_key=NULL,updated_at=? WHERE id=?`, platform.Timestamp(platform.Now()), membership.GroupID); err != nil {
			return err
		}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "group.logo.removed", "group", membership.GroupID, map[string]any{})
	})
	return removedKey, err
}

// MembershipForUser verifies that userID actively belongs to groupID and
// returns the membership with current role IDs and effective permission grants.
// Deprecated compatibility fields are derived from preset assignments. ctx
// bounds the queries; non-members receive ErrForbidden and storage failures are
// returned.
func (s Service) MembershipForUser(ctx context.Context, groupID, userID string) (domain.Membership, error) {
	var membership domain.Membership
	var avatarKey sql.NullString
	err := s.DB.QueryRowContext(ctx, `SELECT m.id,m.group_id,m.user_id,u.email,u.display_name,u.avatar_key,m.status
		FROM memberships m JOIN users u ON u.id=m.user_id JOIN groups g ON g.id=m.group_id
		WHERE m.group_id=? AND m.user_id=? AND m.status='ACTIVE' AND g.status='ACTIVE'`, groupID, userID).
		Scan(&membership.ID, &membership.GroupID, &membership.UserID, &membership.Email, &membership.DisplayName, &avatarKey, &membership.Status)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Membership{}, domain.ErrForbidden
	}
	if err != nil {
		return domain.Membership{}, err
	}
	membership.AvatarURL = media.UserAvatarURL(membership.UserID, avatarKey.String)
	err = s.hydrateMembershipAuthorization(ctx, &membership)
	return membership, err
}

func (s Service) hydrateMembershipAuthorization(ctx context.Context, membership *domain.Membership) error {
	if membership == nil || membership.ID == "" || membership.GroupID == "" {
		return domain.ValidationError{Field: "membership", Message: "requires an id and group id"}
	}
	if err := s.DB.QueryRowContext(ctx, `SELECT m.role_assignments_version,
		(u.email IS NULL AND u.password_hash IS NULL)
		FROM memberships m JOIN users u ON u.id=m.user_id
		WHERE m.id=? AND m.group_id=?`, membership.ID, membership.GroupID).
		Scan(&membership.RoleAssignmentsVersion, &membership.IsTemporaryGuest); err != nil {
		return err
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT r.id,coalesce(r.preset_key,'')
		FROM membership_role_assignments a JOIN roles r ON r.id=a.role_id AND r.group_id=a.group_id
		WHERE a.group_id=? AND a.membership_id=? ORDER BY r.id`, membership.GroupID, membership.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	roleIDs := make(map[string]struct{})
	hasReservedAdministrator := false
	for rows.Next() {
		var roleID string
		var preset domain.RolePresetKey
		if err := rows.Scan(&roleID, &preset); err != nil {
			return err
		}
		roleIDs[roleID] = struct{}{}
		if preset == domain.RolePresetGroupAdministrator {
			hasReservedAdministrator = true
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	membership.RoleIDs = membership.RoleIDs[:0]
	for roleID := range roleIDs {
		membership.RoleIDs = append(membership.RoleIDs, roleID)
	}
	sort.Strings(membership.RoleIDs)
	membership.EffectiveGrants, err = authorization.NewPolicy(s.DB).EffectiveGrants(ctx, membership.GroupID, membership.ID)
	if err != nil {
		return err
	}
	membership.Roles = authorization.LegacyRoles(hasReservedAdministrator, membership.EffectiveGrants)
	membership.GroupPermissions = membership.GroupPermissions[:0]
	for _, grant := range membership.EffectiveGrants {
		if grant.Permission == domain.PermissionRecordOwnPayment && grant.Scope.Type == domain.PermissionScopeGroup {
			membership.GroupPermissions = append(membership.GroupPermissions, domain.PermissionSelfRecordPayment)
			break
		}
	}
	membership.CategoryGrants = map[string][]domain.CategoryPermission{}
	return nil
}

func grantKey(grant domain.PermissionGrant) string {
	return string(grant.Permission) + "\x00" + string(grant.Scope.Type) + "\x00" + grant.Scope.CategoryID + "\x00" + grant.Scope.ProductID
}

// ListMembers returns all members and effective permissions in the caller's
// group. VIEW_MEMBER_DIRECTORY is required and rechecked against current role
// grants; callers cannot widen the tenant scope. SQL errors propagate.
func (s Service) ListMembers(ctx context.Context, membership domain.Membership) ([]domain.Membership, error) {
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionViewMemberDirectory); err != nil {
		return nil, err
	}
	groupID := membership.GroupID
	rows, err := s.DB.QueryContext(ctx, `SELECT m.id,m.group_id,m.user_id,u.email,u.display_name,u.avatar_key,m.status,
		(u.email IS NULL AND u.password_hash IS NULL)
		FROM memberships m JOIN users u ON u.id=m.user_id
		WHERE m.group_id=? AND m.deleted_at IS NULL ORDER BY m.status,lower(u.display_name)`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.Membership, 0)
	for rows.Next() {
		var item domain.Membership
		var avatarKey sql.NullString
		if err := rows.Scan(&item.ID, &item.GroupID, &item.UserID, &item.Email, &item.DisplayName, &avatarKey, &item.Status, &item.IsTemporaryGuest); err != nil {
			return nil, err
		}
		item.AvatarURL = media.UserAvatarURL(item.UserID, avatarKey.String)
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for index := range result {
		if err = s.hydrateMembershipAuthorization(ctx, &result[index]); err != nil {
			return nil, err
		}
	}
	return result, nil
}

// PermissionUpdate is the complete replacement set of group roles,
// group-scoped permissions, and category-scoped grants for one member.
type PermissionUpdate struct {
	Roles            []domain.Role                          `json:"roles"`
	GroupPermissions []domain.GroupPermission               `json:"groupPermissions"`
	CategoryGrants   map[string][]domain.CategoryPermission `json:"categoryGrants"`
}

// UpdatePermissions atomically replaces targetID's deprecated preset-role and
// permission fields while preserving custom role assignments. expectedVersion
// must match the membership's current role-assignment version. The returned
// version identifies the resulting assignment set. It returns precondition,
// forbidden, validation, not-found, last-administrator conflict, cross-tenant,
// audit, or storage errors.
func (s Service) UpdatePermissions(ctx context.Context, actor domain.Principal, actorMembership domain.Membership, targetID string, update PermissionUpdate, expectedVersion int64) (int64, error) {
	if expectedVersion < 1 {
		return 0, fmt.Errorf("%w: a current role-assignment If-Match version is required", domain.ErrPrecondition)
	}
	if err := requireCurrentPermission(ctx, s.DB, actorMembership, domain.PermissionMemberManagement); err != nil {
		return 0, err
	}
	roles, err := validateRoles(update.Roles)
	if err != nil {
		return 0, err
	}
	permissions, err := validateGroupPermissions(update.GroupPermissions)
	if err != nil {
		return 0, err
	}
	if _, err := validateGrants(update.CategoryGrants); err != nil {
		return 0, err
	}
	now := platform.Timestamp(platform.Now())
	var finalVersion int64
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, actorMembership, domain.PermissionMemberManagement); err != nil {
			return err
		}
		var targetGroup string
		var currentVersion int64
		if err := tx.QueryRowContext(ctx, `SELECT group_id,role_assignments_version FROM memberships WHERE id=? AND status='ACTIVE'`, targetID).Scan(&targetGroup, &currentVersion); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		if targetGroup != actorMembership.GroupID {
			return domain.ErrForbidden
		}
		if currentVersion != expectedVersion {
			return domain.ErrPrecondition
		}
		adminRoleID, err := reservedAdministratorRoleID(ctx, tx, targetGroup)
		if err != nil {
			return err
		}
		currentRoleIDs, err := assignedRoleIDs(ctx, tx, targetGroup, domain.RoleAssignmentMembership, targetID)
		if err != nil {
			return err
		}
		nextRoleIDs, err := legacyAssignmentRoleIDs(targetGroup, currentRoleIDs, roles, permissions)
		if err != nil {
			return err
		}
		if err := requireAssignmentChangePermissions(ctx, tx, actorMembership, adminRoleID, currentRoleIDs, nextRoleIDs); err != nil {
			return err
		}
		hadAdmin := containsString(currentRoleIDs, adminRoleID)
		willAdmin := containsString(nextRoleIDs, adminRoleID)
		if hadAdmin && !willAdmin {
			var admins int
			if err := tx.QueryRowContext(ctx, `SELECT count(DISTINCT a.membership_id) FROM membership_role_assignments a JOIN roles r ON r.id=a.role_id AND r.group_id=a.group_id JOIN memberships m ON m.id=a.membership_id AND m.group_id=a.group_id WHERE a.group_id=? AND r.preset_key='GROUP_ADMINISTRATOR' AND m.status='ACTIVE'`, targetGroup).Scan(&admins); err != nil {
				return err
			}
			if admins <= 1 {
				return fmt.Errorf("%w: the last active administrator cannot be removed", domain.ErrConflict)
			}
		}
		if containsGroupPermission(permissions, domain.PermissionSelfRecordPayment) {
			if err := ensureLegacySelfPaymentRoleTx(ctx, tx, targetGroup, actor.UserID, now); err != nil {
				return err
			}
		}
		if err := validateAssignedRoles(ctx, tx, targetGroup, nextRoleIDs); err != nil {
			return err
		}
		if err := replaceAssignmentRowsTx(ctx, tx, actor.UserID, targetGroup, domain.RoleAssignmentMembership, targetID, currentRoleIDs, nextRoleIDs, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM membership_roles WHERE membership_id=?`, targetID); err != nil {
			return err
		}
		for _, role := range roles {
			if _, err := tx.ExecContext(ctx, `INSERT INTO membership_roles(group_id,membership_id,role,granted_at,granted_by) VALUES(?,?,?,?,?)`, targetGroup, targetID, role, now, actor.UserID); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM membership_permissions WHERE membership_id=?`, targetID); err != nil {
			return err
		}
		for _, permission := range permissions {
			if _, err := tx.ExecContext(ctx, `INSERT INTO membership_permissions(group_id,membership_id,permission,granted_at,granted_by) VALUES(?,?,?,?,?)`, targetGroup, targetID, permission, now, actor.UserID); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM category_permissions WHERE membership_id=?`, targetID); err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx, `SELECT role_assignments_version FROM memberships WHERE id=? AND group_id=?`, targetID, targetGroup).Scan(&finalVersion); err != nil {
			return err
		}
		return audit.Record(ctx, tx, targetGroup, actor.UserID, actorMembership.ID, "membership.permissions.updated", "membership", targetID, map[string]any{
			"roles": roles, "groupPermissions": permissions, "categoryGrants": map[string][]domain.CategoryPermission{}, "version": finalVersion,
		})
	})
	return finalVersion, err
}

// ArchiveMember removes an active membership from the administrator's group
// without deleting its financial or audit history. targetID identifies the
// membership; confirmSelf must be true when the actor removes their own
// membership. The operation clears all effective roles, group permissions, and category grants and
// returns authorization, validation, not-found, last-administrator, audit, or
// database errors.
func (s Service) ArchiveMember(ctx context.Context, actor domain.Principal, actorMembership domain.Membership, targetID string, confirmSelf bool) error {
	if err := requireCurrentPermission(ctx, s.DB, actorMembership, domain.PermissionMemberManagement); err != nil {
		return err
	}
	targetID = strings.TrimSpace(targetID)
	if targetID == "" {
		return domain.ValidationError{Field: "membershipId", Message: "is required"}
	}
	now := platform.Timestamp(platform.Now())
	return storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, actorMembership, domain.PermissionMemberManagement); err != nil {
			return err
		}
		var targetGroupID, targetUserID, status string
		err := tx.QueryRowContext(ctx, `SELECT group_id,user_id,status FROM memberships WHERE id=?`, targetID).
			Scan(&targetGroupID, &targetUserID, &status)
		if errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		}
		if err != nil {
			return err
		}
		if targetGroupID != actorMembership.GroupID {
			return domain.ErrForbidden
		}
		if status != "ACTIVE" {
			return fmt.Errorf("%w: membership is not active", domain.ErrConflict)
		}
		if targetUserID == actor.UserID && !confirmSelf {
			return domain.ValidationError{Field: "confirmSelf", Message: "must be true to remove your own membership"}
		}
		var targetHasGroupAdministration int
		if err := tx.QueryRowContext(ctx, `SELECT count(*)
			FROM membership_role_assignments assignment
			JOIN role_permission_grants grant_row ON grant_row.group_id=assignment.group_id AND grant_row.role_id=assignment.role_id
			WHERE assignment.group_id=? AND assignment.membership_id=?
			AND grant_row.permission_key='GROUP_ADMINISTRATION' AND grant_row.scope_type='GROUP'`, targetGroupID, targetID).Scan(&targetHasGroupAdministration); err != nil {
			return err
		}
		if targetHasGroupAdministration > 0 {
			if err := requireCurrentPermission(ctx, tx, actorMembership, domain.PermissionGroupAdministration); err != nil {
				return err
			}
		}
		var targetIsAdmin int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM membership_role_assignments a JOIN roles r ON r.id=a.role_id AND r.group_id=a.group_id WHERE a.membership_id=? AND a.group_id=? AND r.preset_key='GROUP_ADMINISTRATOR'`, targetID, targetGroupID).Scan(&targetIsAdmin); err != nil {
			return err
		}
		if targetIsAdmin > 0 {
			var activeAdministrators int
			if err := tx.QueryRowContext(ctx, `SELECT count(DISTINCT a.membership_id)
				FROM membership_role_assignments a JOIN roles r ON r.id=a.role_id AND r.group_id=a.group_id JOIN memberships m ON m.id=a.membership_id AND m.group_id=a.group_id
				WHERE a.group_id=? AND r.preset_key='GROUP_ADMINISTRATOR' AND m.status='ACTIVE'`, targetGroupID).Scan(&activeAdministrators); err != nil {
				return err
			}
			if activeAdministrators <= 1 {
				return fmt.Errorf("%w: the last active administrator cannot be removed", domain.ErrConflict)
			}
		}
		if err := revokeMemberClaimInvitationsTx(ctx, tx, targetGroupID, targetID, now, "membership_archived"); err != nil {
			return err
		}
		if err := clearMemberLegacyAuthorizationTx(ctx, tx, targetID); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `UPDATE memberships SET status='ARCHIVED',archived_at=? WHERE id=? AND group_id=? AND status='ACTIVE'`, now, targetID, targetGroupID)
		if err != nil {
			return err
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if changed != 1 {
			return fmt.Errorf("%w: membership state changed", domain.ErrConflict)
		}
		return audit.Record(ctx, tx, targetGroupID, actor.UserID, actorMembership.ID, "membership.archived", "membership", targetID, map[string]any{"selfRemoval": targetUserID == actor.UserID})
	})
}

func validateRoles(input []domain.Role) ([]domain.Role, error) {
	seen := map[domain.Role]bool{}
	for _, role := range input {
		switch role {
		case domain.RoleAdmin, domain.RoleFinanceManager, domain.RoleCatalogManager:
			seen[role] = true
		default:
			return nil, domain.ValidationError{Field: "roles", Message: "contains an unsupported role"}
		}
	}
	result := make([]domain.Role, 0, len(seen))
	for role := range seen {
		result = append(result, role)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result, nil
}

func validateGroupPermissions(input []domain.GroupPermission) ([]domain.GroupPermission, error) {
	seen := map[domain.GroupPermission]bool{}
	for _, permission := range input {
		switch permission {
		case domain.PermissionSelfRecordPayment:
			seen[permission] = true
		default:
			return nil, domain.ValidationError{Field: "groupPermissions", Message: "contains an unsupported permission"}
		}
	}
	result := make([]domain.GroupPermission, 0, len(seen))
	for permission := range seen {
		result = append(result, permission)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result, nil
}

func validateGrants(input map[string][]domain.CategoryPermission) (map[string][]domain.CategoryPermission, error) {
	if len(input) > 0 {
		return nil, domain.ValidationError{Field: "categoryGrants", Message: "category-scoped legacy grants are no longer accepted; assign group roles instead"}
	}
	return map[string][]domain.CategoryPermission{}, nil
}

func validateInvitationGrantCategoriesTx(ctx context.Context, tx *sql.Tx, groupID string, grants map[string][]domain.CategoryPermission) error {
	for categoryID := range grants {
		var categoryGroupID string
		err := tx.QueryRowContext(ctx, `SELECT group_id FROM categories WHERE id=?`, categoryID).Scan(&categoryGroupID)
		if errors.Is(err, sql.ErrNoRows) {
			return domain.ValidationError{Field: "categoryGrants", Message: "contains an unknown category"}
		}
		if err != nil {
			return err
		}
		if categoryGroupID != groupID {
			return domain.ErrForbidden
		}
	}
	return nil
}

func containsRole(roles []domain.Role, expected domain.Role) bool {
	for _, role := range roles {
		if role == expected {
			return true
		}
	}
	return false
}

func containsGroupPermission(permissions []domain.GroupPermission, expected domain.GroupPermission) bool {
	for _, permission := range permissions {
		if permission == expected {
			return true
		}
	}
	return false
}

func ensureLegacySelfPaymentRoleTx(ctx context.Context, tx *sql.Tx, groupID, actorUserID, now string) error {
	roleID := "role:LEGACY_SELF_PAYMENT:" + groupID
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO roles(id,group_id,name,description,name_locked,deletable,version,created_at,updated_at,created_by,updated_by) VALUES(?,?,'Migrated self-payment access','Preserves the deprecated SELF_RECORD_PAYMENT grant.',0,1,1,?,?,?,?)`, roleID, groupID, now, now, actorUserID, actorUserID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO role_permission_grants(group_id,role_id,permission_key,scope_type,version,created_at,updated_at,created_by,updated_by) VALUES(?,?,'RECORD_OWN_PAYMENT','GROUP',1,?,?,?,?)`, groupID, roleID, now, now, actorUserID, actorUserID)
	return err
}

func legacyAssignmentRoleIDs(groupID string, currentRoleIDs []string, roles []domain.Role, permissions []domain.GroupPermission) ([]string, error) {
	roleIDs := map[string]struct{}{}
	for _, role := range roles {
		var roleID string
		switch role {
		case domain.RoleAdmin:
			roleID = authorization.PresetRoleID(groupID, domain.RolePresetGroupAdministrator)
		case domain.RoleFinanceManager:
			roleID = authorization.TemplateRoleID(groupID, domain.RoleTemplateFinance)
		case domain.RoleCatalogManager:
			roleID = authorization.TemplateRoleID(groupID, domain.RoleTemplateCatalog)
		}
		if roleID != "" {
			roleIDs[roleID] = struct{}{}
		}
	}
	legacySelfRoleID := "role:LEGACY_SELF_PAYMENT:" + groupID
	if containsGroupPermission(permissions, domain.PermissionSelfRecordPayment) {
		roleIDs[legacySelfRoleID] = struct{}{}
	}
	managedRoleIDs := map[string]struct{}{
		authorization.PresetRoleID(groupID, domain.RolePresetGroupAdministrator): {},
		authorization.TemplateRoleID(groupID, domain.RoleTemplateFinance):        {},
		authorization.TemplateRoleID(groupID, domain.RoleTemplateCatalog):        {},
	}
	for _, roleID := range currentRoleIDs {
		if _, managed := managedRoleIDs[roleID]; !managed && roleID != legacySelfRoleID {
			roleIDs[roleID] = struct{}{}
		}
	}
	result := make([]string, 0, len(roleIDs))
	for roleID := range roleIDs {
		result = append(result, roleID)
	}
	return normalizeRoleIDs(result), nil
}

// Invitation includes safe onboarding metadata and, only in the immediate
// CreateInvitation result, the one-time plaintext Token.
type Invitation struct {
	ID                     string                                 `json:"id"`
	GroupID                string                                 `json:"groupId"`
	TargetMembershipID     *string                                `json:"targetMembershipId,omitempty"`
	Email                  string                                 `json:"email"`
	DisplayName            string                                 `json:"displayName,omitempty"`
	Roles                  []domain.Role                          `json:"roles"`
	GroupPermissions       []domain.GroupPermission               `json:"groupPermissions"`
	CategoryGrants         map[string][]domain.CategoryPermission `json:"categoryGrants"`
	RoleIDs                []string                               `json:"roleIds"`
	RoleAssignmentsVersion int64                                  `json:"roleAssignmentsVersion"`
	ExpiresAt              string                                 `json:"expiresAt"`
	AcceptedAt             *string                                `json:"acceptedAt,omitempty"`
	RevokedAt              *string                                `json:"revokedAt,omitempty"`
	EmailDeliveryStatus    EmailDeliveryStatus                    `json:"emailDeliveryStatus"`
	EmailSentAt            *string                                `json:"emailSentAt,omitempty"`
	EmailFailureCode       string                                 `json:"emailFailureCode,omitempty"`
	Token                  string                                 `json:"token,omitempty"`
}

type invitationAssignmentAuthorization uint8

const (
	invitationAssignmentStandard invitationAssignmentAuthorization = iota
	invitationAssignmentTemporaryGuestClaim
)

// CreateInvitation creates a seven-day, one-time invitation in membership's
// group. When TokenSealer is configured, the same transaction also queues an
// encrypted email job while retaining the plaintext token in the immediate
// result for manual fallback sharing. ctx bounds the transaction; actor is
// audited and email/roles are validated. It returns the invitation or forbidden,
// validation, randomness, encryption, audit, and database errors.
func (s Service) CreateInvitation(ctx context.Context, actor domain.Principal, membership domain.Membership, email, displayName string, roles []domain.Role, groupPermissions []domain.GroupPermission, categoryGrants map[string][]domain.CategoryPermission) (Invitation, error) {
	return s.createInvitation(ctx, actor, membership, email, displayName, roles, groupPermissions, categoryGrants, nil)
}

// CreateInvitationWithRoles creates an invitation with a complete, explicitly
// selected, non-empty dynamic role set.
func (s Service) CreateInvitationWithRoles(ctx context.Context, actor domain.Principal, membership domain.Membership, email, displayName string, roleIDs []string) (Invitation, error) {
	return s.createInvitation(ctx, actor, membership, email, displayName, nil, nil, nil, append([]string{}, roleIDs...))
}

func (s Service) createInvitation(ctx context.Context, actor domain.Principal, membership domain.Membership, email, displayName string, roles []domain.Role, groupPermissions []domain.GroupPermission, categoryGrants map[string][]domain.CategoryPermission, roleIDs []string) (Invitation, error) {
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionMemberManagement); err != nil {
		return Invitation{}, err
	}
	var err error
	email, err = platform.NormalizeEmail(email)
	if err != nil {
		return Invitation{}, domain.ValidationError{Field: "email", Message: "must be a valid email address"}
	}
	displayName = strings.TrimSpace(displayName)
	if len(displayName) > 120 || containsControlCharacter(displayName) {
		return Invitation{}, domain.ValidationError{Field: "displayName", Message: "must contain at most 120 characters without control characters"}
	}
	roles, err = validateRoles(roles)
	if err != nil {
		return Invitation{}, err
	}
	groupPermissions, err = validateGroupPermissions(groupPermissions)
	if err != nil {
		return Invitation{}, err
	}
	categoryGrants, err = validateGrants(categoryGrants)
	if err != nil {
		return Invitation{}, err
	}
	var item Invitation
	now := platform.Now()
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, membership, domain.PermissionMemberManagement); err != nil {
			return err
		}
		item, err = createInvitationTx(ctx, tx, actor, membership, email, displayName, roles, groupPermissions, categoryGrants, roleIDs, now, invitationAssignmentStandard)
		if err != nil || s.TokenSealer == nil {
			return err
		}
		if err := s.queueInvitationEmailTx(ctx, tx, actor, membership, item, now); err != nil {
			return err
		}
		item.EmailDeliveryStatus = EmailDeliveryPending
		return nil
	})
	return item, err
}

func createInvitationTx(ctx context.Context, tx *sql.Tx, actor domain.Principal, membership domain.Membership, email, displayName string, roles []domain.Role, groupPermissions []domain.GroupPermission, categoryGrants map[string][]domain.CategoryPermission, roleIDs []string, now time.Time, assignmentAuthorization invitationAssignmentAuthorization) (Invitation, error) {
	dynamicRoleCommand := roleIDs != nil
	if roles == nil {
		roles = []domain.Role{}
	}
	if groupPermissions == nil {
		groupPermissions = []domain.GroupPermission{}
	}
	if categoryGrants == nil {
		categoryGrants = map[string][]domain.CategoryPermission{}
	}
	nowText := platform.Timestamp(now)
	currentRoleIDs := []string{}
	var nextRoleIDs []string
	var err error
	if dynamicRoleCommand {
		nextRoleIDs = normalizeRoleIDs(roleIDs)
	} else {
		nextRoleIDs, err = legacyAssignmentRoleIDs(membership.GroupID, nil, roles, groupPermissions)
		if err != nil {
			return Invitation{}, err
		}
	}
	switch assignmentAuthorization {
	case invitationAssignmentStandard:
		adminRoleID, err := reservedAdministratorRoleID(ctx, tx, membership.GroupID)
		if err != nil {
			return Invitation{}, err
		}
		if err := requireAssignmentChangePermissions(ctx, tx, membership, adminRoleID, currentRoleIDs, nextRoleIDs); err != nil {
			return Invitation{}, err
		}
	case invitationAssignmentTemporaryGuestClaim:
		if err := requireCurrentPermission(ctx, tx, membership, domain.PermissionMemberManagement); err != nil {
			return Invitation{}, err
		}
		var defaultRoleID string
		if err := tx.QueryRowContext(ctx, `SELECT default_role_id FROM group_settings WHERE group_id=? AND default_role_id IS NOT NULL`, membership.GroupID).Scan(&defaultRoleID); errors.Is(err, sql.ErrNoRows) {
			return Invitation{}, domain.ValidationError{Field: "roleIds", Message: "requires a configured default role"}
		} else if err != nil {
			return Invitation{}, err
		}
		if len(nextRoleIDs) != 1 || nextRoleIDs[0] != defaultRoleID {
			adminRoleID, err := reservedAdministratorRoleID(ctx, tx, membership.GroupID)
			if err != nil {
				return Invitation{}, err
			}
			if err := requireAssignmentChangePermissions(ctx, tx, membership, adminRoleID, currentRoleIDs, nextRoleIDs); err != nil {
				return Invitation{}, err
			}
		}
	default:
		return Invitation{}, errors.New("unsupported invitation assignment authorization mode")
	}
	if containsGroupPermission(groupPermissions, domain.PermissionSelfRecordPayment) {
		if err := ensureLegacySelfPaymentRoleTx(ctx, tx, membership.GroupID, actor.UserID, nowText); err != nil {
			return Invitation{}, err
		}
	}
	if err := validateAssignedRoles(ctx, tx, membership.GroupID, nextRoleIDs); err != nil {
		return Invitation{}, err
	}
	var existing int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM memberships m JOIN users u ON u.id=m.user_id
		WHERE m.group_id=? AND u.email=? AND m.status='ACTIVE'`, membership.GroupID, email).Scan(&existing); err != nil {
		return Invitation{}, err
	}
	if existing > 0 {
		return Invitation{}, fmt.Errorf("%w: %w", domain.ErrConflict, ErrMembershipEmailExists)
	}
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM invitations
		WHERE group_id=? AND email=? AND accepted_at IS NULL AND revoked_at IS NULL
		AND julianday(expires_at)>julianday(?)`, membership.GroupID, email, nowText).Scan(&existing); err != nil {
		return Invitation{}, err
	}
	if existing > 0 {
		return Invitation{}, fmt.Errorf("%w: %w", domain.ErrConflict, ErrInvitationEmailExists)
	}
	var targetUserID sql.NullString
	if err := tx.QueryRowContext(ctx, `SELECT id FROM users
		WHERE email=? COLLATE NOCASE AND active=1 AND email IS NOT NULL AND password_hash IS NOT NULL`, email).Scan(&targetUserID); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Invitation{}, err
	}

	id, err := platform.NewID("inv")
	if err != nil {
		return Invitation{}, err
	}
	token, err := platform.NewSecret()
	if err != nil {
		return Invitation{}, err
	}
	encoded, err := json.Marshal(roles)
	if err != nil {
		return Invitation{}, fmt.Errorf("encode invitation roles: %w", err)
	}
	encodedPermissions, err := json.Marshal(groupPermissions)
	if err != nil {
		return Invitation{}, fmt.Errorf("encode invitation group permissions: %w", err)
	}
	if err := validateInvitationGrantCategoriesTx(ctx, tx, membership.GroupID, categoryGrants); err != nil {
		return Invitation{}, err
	}
	encodedGrants, err := json.Marshal(categoryGrants)
	if err != nil {
		return Invitation{}, fmt.Errorf("encode invitation category grants: %w", err)
	}
	item := Invitation{
		ID: id, GroupID: membership.GroupID, Email: email, DisplayName: displayName,
		Roles: roles, GroupPermissions: groupPermissions, CategoryGrants: categoryGrants, ExpiresAt: platform.Timestamp(now.Add(7 * 24 * time.Hour)),
		EmailDeliveryStatus: EmailDeliveryNotRequested, Token: token,
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO invitations(id,group_id,email,display_name,token_hash,roles_json,group_permissions_json,category_grants_json,expires_at,created_by,created_at,target_user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
		item.ID, membership.GroupID, email, nullable(displayName), platform.HashSecret(token), string(encoded), string(encodedPermissions), string(encodedGrants), item.ExpiresAt, actor.UserID, nowText, targetUserID); err != nil {
		if strings.Contains(err.Error(), activeInvitationEmailConstraint) {
			return Invitation{}, fmt.Errorf("%w: %w", domain.ErrConflict, ErrInvitationEmailExists)
		}
		return Invitation{}, err
	}
	insertedRoleIDs, err := assignedRoleIDs(ctx, tx, membership.GroupID, domain.RoleAssignmentInvitation, item.ID)
	if err != nil {
		return Invitation{}, err
	}
	if err := replaceAssignmentRowsTx(ctx, tx, actor.UserID, membership.GroupID, domain.RoleAssignmentInvitation, item.ID, insertedRoleIDs, nextRoleIDs, nowText); err != nil {
		return Invitation{}, err
	}
	item.RoleIDs, err = assignedRoleIDs(ctx, tx, membership.GroupID, domain.RoleAssignmentInvitation, item.ID)
	if err != nil {
		return Invitation{}, err
	}
	if dynamicRoleCommand {
		item.Roles, item.GroupPermissions, err = legacyAuthorizationForRoleIDs(ctx, tx, membership.GroupID, item.RoleIDs)
		if err != nil {
			return Invitation{}, err
		}
		encodedRoles, err := json.Marshal(item.Roles)
		if err != nil {
			return Invitation{}, fmt.Errorf("encode compatible invitation roles: %w", err)
		}
		encodedPermissions, err := json.Marshal(item.GroupPermissions)
		if err != nil {
			return Invitation{}, fmt.Errorf("encode compatible invitation permissions: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE invitations SET roles_json=?,group_permissions_json=?,category_grants_json='{}' WHERE id=? AND group_id=?`, string(encodedRoles), string(encodedPermissions), item.ID, membership.GroupID); err != nil {
			return Invitation{}, err
		}
	}
	if err := tx.QueryRowContext(ctx, `SELECT role_assignments_version FROM invitations WHERE id=? AND group_id=?`, item.ID, membership.GroupID).Scan(&item.RoleAssignmentsVersion); err != nil {
		return Invitation{}, err
	}
	if err := audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "invitation.created", "invitation", item.ID, map[string]any{"email": email, "roles": roles, "groupPermissions": groupPermissions, "categoryGrants": categoryGrants}); err != nil {
		return Invitation{}, err
	}
	return item, nil
}

// UpdateInvitation replaces the editable profile and deprecated permission
// defaults of an open invitation while preserving custom role assignments.
// expectedVersion must match the current role-assignment version. The email
// address and token remain unchanged. It returns the updated secret-free
// invitation or a precondition, authorization, validation, state, audit, or
// database error.
func (s Service) UpdateInvitation(ctx context.Context, actor domain.Principal, membership domain.Membership, invitationID, displayName string, roles []domain.Role, groupPermissions []domain.GroupPermission, categoryGrants map[string][]domain.CategoryPermission, expectedVersion int64) (Invitation, error) {
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionMemberManagement); err != nil {
		return Invitation{}, err
	}
	invitationID = strings.TrimSpace(invitationID)
	if invitationID == "" || expectedVersion < 1 {
		return Invitation{}, fmt.Errorf("%w: an invitation id and current role-assignment If-Match version are required", domain.ErrPrecondition)
	}
	displayName = strings.TrimSpace(displayName)
	if len(displayName) > 120 || containsControlCharacter(displayName) {
		return Invitation{}, domain.ValidationError{Field: "displayName", Message: "must contain at most 120 characters without control characters"}
	}
	var err error
	roles, err = validateRoles(roles)
	if err != nil {
		return Invitation{}, err
	}
	groupPermissions, err = validateGroupPermissions(groupPermissions)
	if err != nil {
		return Invitation{}, err
	}
	categoryGrants, err = validateGrants(categoryGrants)
	if err != nil {
		return Invitation{}, err
	}
	var item Invitation
	err = storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, membership, domain.PermissionMemberManagement); err != nil {
			return err
		}
		var acceptedAt, revokedAt sql.NullString
		var encodedRoles, encodedPermissions, encodedGrants string
		err := tx.QueryRowContext(ctx, `SELECT i.id,i.group_id,i.target_membership_id,i.email,coalesce(i.display_name,''),i.roles_json,i.group_permissions_json,i.category_grants_json,i.role_assignments_version,
			i.expires_at,i.accepted_at,i.revoked_at,coalesce(o.status,'NOT_REQUESTED'),o.sent_at,coalesce(o.last_error_code,'')
			FROM invitations i LEFT JOIN invitation_email_outbox o ON o.invitation_id=i.id
			WHERE i.id=? AND i.group_id=?`, invitationID, membership.GroupID).
			Scan(&item.ID, &item.GroupID, &item.TargetMembershipID, &item.Email, &item.DisplayName, &encodedRoles, &encodedPermissions, &encodedGrants, &item.RoleAssignmentsVersion, &item.ExpiresAt, &acceptedAt, &revokedAt, &item.EmailDeliveryStatus, &item.EmailSentAt, &item.EmailFailureCode)
		if errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		}
		if err != nil {
			return err
		}
		if acceptedAt.Valid || revokedAt.Valid {
			return fmt.Errorf("%w: invitation is no longer editable", domain.ErrConflict)
		}
		expiresAt, err := time.Parse(time.RFC3339Nano, item.ExpiresAt)
		if err != nil {
			return fmt.Errorf("parse invitation expiration: %w", err)
		}
		if !expiresAt.After(platform.Now()) {
			return fmt.Errorf("%w: invitation has expired", domain.ErrConflict)
		}
		if item.RoleAssignmentsVersion != expectedVersion {
			return domain.ErrPrecondition
		}
		if err := validateInvitationGrantCategoriesTx(ctx, tx, membership.GroupID, categoryGrants); err != nil {
			return err
		}
		currentRoleIDs, err := assignedRoleIDs(ctx, tx, membership.GroupID, domain.RoleAssignmentInvitation, invitationID)
		if err != nil {
			return err
		}
		adminRoleID, err := reservedAdministratorRoleID(ctx, tx, membership.GroupID)
		if err != nil {
			return err
		}
		roleIDs, err := legacyAssignmentRoleIDs(membership.GroupID, currentRoleIDs, roles, groupPermissions)
		if err != nil {
			return err
		}
		if err := requireAssignmentChangePermissions(ctx, tx, membership, adminRoleID, currentRoleIDs, roleIDs); err != nil {
			return err
		}
		now := platform.Timestamp(platform.Now())
		if containsGroupPermission(groupPermissions, domain.PermissionSelfRecordPayment) {
			if err := ensureLegacySelfPaymentRoleTx(ctx, tx, membership.GroupID, actor.UserID, now); err != nil {
				return err
			}
		}
		if err := validateAssignedRoles(ctx, tx, membership.GroupID, roleIDs); err != nil {
			return err
		}
		encodedRolesBytes, err := json.Marshal(roles)
		if err != nil {
			return fmt.Errorf("encode invitation roles: %w", err)
		}
		encodedGrantBytes, err := json.Marshal(categoryGrants)
		if err != nil {
			return fmt.Errorf("encode invitation category grants: %w", err)
		}
		encodedPermissionBytes, err := json.Marshal(groupPermissions)
		if err != nil {
			return fmt.Errorf("encode invitation group permissions: %w", err)
		}
		if err := replaceAssignmentRowsTx(ctx, tx, actor.UserID, membership.GroupID, domain.RoleAssignmentInvitation, invitationID, currentRoleIDs, roleIDs, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE invitations SET display_name=?,roles_json=?,group_permissions_json=?,category_grants_json=? WHERE id=? AND group_id=? AND accepted_at IS NULL AND revoked_at IS NULL`,
			nullable(displayName), string(encodedRolesBytes), string(encodedPermissionBytes), string(encodedGrantBytes), invitationID, membership.GroupID); err != nil {
			return err
		}
		item.DisplayName = displayName
		item.Roles = roles
		item.GroupPermissions = groupPermissions
		item.CategoryGrants = categoryGrants
		item.RoleIDs = roleIDs
		if err := tx.QueryRowContext(ctx, `SELECT role_assignments_version FROM invitations WHERE id=? AND group_id=?`, invitationID, membership.GroupID).Scan(&item.RoleAssignmentsVersion); err != nil {
			return err
		}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "invitation.updated", "invitation", invitationID, map[string]any{"displayName": displayName, "roles": roles, "groupPermissions": groupPermissions, "categoryGrants": categoryGrants})
	})
	return item, err
}

// UpdateInvitationWithRoles atomically updates an open invitation's display
// name and complete dynamic role set under one assignment ETag.
func (s Service) UpdateInvitationWithRoles(ctx context.Context, actor domain.Principal, membership domain.Membership, invitationID, displayName string, roleIDs []string, expectedVersion int64) (Invitation, error) {
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionMemberManagement); err != nil {
		return Invitation{}, err
	}
	invitationID = strings.TrimSpace(invitationID)
	displayName = strings.TrimSpace(displayName)
	if invitationID == "" || expectedVersion < 1 {
		return Invitation{}, domain.ValidationError{Field: "invitation", Message: "id and a current If-Match version are required"}
	}
	if len(displayName) > 120 || containsControlCharacter(displayName) {
		return Invitation{}, domain.ValidationError{Field: "displayName", Message: "must contain at most 120 characters without control characters"}
	}
	roleIDs = normalizeRoleIDs(roleIDs)
	if len(roleIDs) == 0 {
		return Invitation{}, domain.ValidationError{Field: "roleIds", Message: "must contain at least one role"}
	}
	var item Invitation
	err := storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, membership, domain.PermissionMemberManagement); err != nil {
			return err
		}
		var acceptedAt, revokedAt sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT i.id,i.group_id,i.target_membership_id,i.email,coalesce(i.display_name,''),i.role_assignments_version,i.expires_at,i.accepted_at,i.revoked_at,coalesce(o.status,'NOT_REQUESTED'),o.sent_at,coalesce(o.last_error_code,'') FROM invitations i LEFT JOIN invitation_email_outbox o ON o.invitation_id=i.id WHERE i.id=? AND i.group_id=?`, invitationID, membership.GroupID).
			Scan(&item.ID, &item.GroupID, &item.TargetMembershipID, &item.Email, &item.DisplayName, &item.RoleAssignmentsVersion, &item.ExpiresAt, &acceptedAt, &revokedAt, &item.EmailDeliveryStatus, &item.EmailSentAt, &item.EmailFailureCode); errors.Is(err, sql.ErrNoRows) {
			return domain.ErrNotFound
		} else if err != nil {
			return err
		}
		if acceptedAt.Valid || revokedAt.Valid {
			return fmt.Errorf("%w: invitation is no longer editable", domain.ErrConflict)
		}
		expiresAt, err := time.Parse(time.RFC3339Nano, item.ExpiresAt)
		if err != nil {
			return fmt.Errorf("parse invitation expiration: %w", err)
		}
		if !expiresAt.After(platform.Now()) {
			return fmt.Errorf("%w: invitation has expired", domain.ErrConflict)
		}
		if item.RoleAssignmentsVersion != expectedVersion {
			return domain.ErrPrecondition
		}
		if err := validateAssignedRoles(ctx, tx, membership.GroupID, roleIDs); err != nil {
			return err
		}
		currentRoleIDs, err := assignedRoleIDs(ctx, tx, membership.GroupID, domain.RoleAssignmentInvitation, invitationID)
		if err != nil {
			return err
		}
		adminRoleID, err := reservedAdministratorRoleID(ctx, tx, membership.GroupID)
		if err != nil {
			return err
		}
		if err := requireAssignmentChangePermissions(ctx, tx, membership, adminRoleID, currentRoleIDs, roleIDs); err != nil {
			return err
		}
		now := platform.Timestamp(platform.Now())
		if err := replaceAssignmentRowsTx(ctx, tx, actor.UserID, membership.GroupID, domain.RoleAssignmentInvitation, invitationID, currentRoleIDs, roleIDs, now); err != nil {
			return err
		}
		legacyRoles, legacyPermissions, err := legacyAuthorizationForRoleIDs(ctx, tx, membership.GroupID, roleIDs)
		if err != nil {
			return err
		}
		encodedRoles, err := json.Marshal(legacyRoles)
		if err != nil {
			return fmt.Errorf("encode compatible invitation roles: %w", err)
		}
		encodedPermissions, err := json.Marshal(legacyPermissions)
		if err != nil {
			return fmt.Errorf("encode compatible invitation permissions: %w", err)
		}
		updated, err := tx.ExecContext(ctx, `UPDATE invitations SET display_name=?,roles_json=?,group_permissions_json=?,category_grants_json='{}' WHERE id=? AND group_id=? AND accepted_at IS NULL AND revoked_at IS NULL`, nullable(displayName), string(encodedRoles), string(encodedPermissions), invitationID, membership.GroupID)
		if err != nil {
			return err
		}
		if changed, _ := updated.RowsAffected(); changed != 1 {
			return domain.ErrConflict
		}
		item.DisplayName = displayName
		item.Roles = legacyRoles
		item.GroupPermissions = legacyPermissions
		item.CategoryGrants = map[string][]domain.CategoryPermission{}
		item.RoleIDs = roleIDs
		if err := tx.QueryRowContext(ctx, `SELECT role_assignments_version FROM invitations WHERE id=? AND group_id=?`, invitationID, membership.GroupID).Scan(&item.RoleAssignmentsVersion); err != nil {
			return err
		}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "invitation.updated", "invitation", invitationID, map[string]any{"displayName": displayName, "roleIds": roleIDs, "version": item.RoleAssignmentsVersion})
	})
	return item, err
}

// RevokeInvitation invalidates one unconsumed invitation in membership's group
// and records the administrative reason. ctx bounds the transaction. It returns
// forbidden, validation, not-found, audit, or database errors. Example:
// RevokeInvitation(ctx, actor, membership, invitationID, "email delivery failed").
func (s Service) RevokeInvitation(ctx context.Context, actor domain.Principal, membership domain.Membership, invitationID, reason string) error {
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionMemberManagement); err != nil {
		return err
	}
	reason = strings.TrimSpace(reason)
	if reason == "" || len(reason) > 240 {
		return domain.ValidationError{Field: "reason", Message: "must contain 1 to 240 characters"}
	}
	now := platform.Timestamp(platform.Now())
	return storage.WithTx(ctx, s.DB, func(tx *sql.Tx) error {
		if err := requireCurrentPermission(ctx, tx, membership, domain.PermissionMemberManagement); err != nil {
			return err
		}
		invalidatedTokenHash := platform.HashSecret("revoked:" + invitationID + ":" + now)
		result, err := tx.ExecContext(ctx, `UPDATE invitations SET revoked_at=?,token_hash=?
			WHERE id=? AND group_id=? AND accepted_at IS NULL AND revoked_at IS NULL`, now, invalidatedTokenHash, invitationID, membership.GroupID)
		if err != nil {
			return err
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if changed == 0 {
			return domain.ErrNotFound
		}
		if _, err := tx.ExecContext(ctx, `UPDATE invitation_email_outbox SET
			status='CANCELLED',token_ciphertext=NULL,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,last_error_code='invitation_revoked',updated_at=?
			WHERE invitation_id=? AND group_id=? AND status IN ('PENDING','SENDING','FAILED')`, now, invitationID, membership.GroupID); err != nil {
			return err
		}
		return audit.Record(ctx, tx, membership.GroupID, actor.UserID, membership.ID, "invitation.revoked", "invitation", invitationID, map[string]any{"reason": reason})
	})
}

// ListInvitations returns the complete newest-first invitation lifecycle
// without bearer tokens. MEMBER_MANAGEMENT is required.
func (s Service) ListInvitations(ctx context.Context, membership domain.Membership) ([]Invitation, error) {
	if err := requireCurrentPermission(ctx, s.DB, membership, domain.PermissionMemberManagement); err != nil {
		return nil, err
	}
	query := `SELECT i.id,i.group_id,i.target_membership_id,i.email,coalesce(i.display_name,''),i.roles_json,i.group_permissions_json,i.category_grants_json,i.role_assignments_version,
		i.expires_at,i.accepted_at,i.revoked_at,coalesce(o.status,'NOT_REQUESTED'),o.sent_at,coalesce(o.last_error_code,'')
		FROM invitations i LEFT JOIN invitation_email_outbox o ON o.invitation_id=i.id
		WHERE i.group_id=?`
	query += ` ORDER BY i.created_at DESC`
	rows, err := s.DB.QueryContext(ctx, query, membership.GroupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Invitation, 0)
	for rows.Next() {
		var item Invitation
		var encodedRoles, encodedPermissions, encodedGrants string
		if err := rows.Scan(&item.ID, &item.GroupID, &item.TargetMembershipID, &item.Email, &item.DisplayName, &encodedRoles, &encodedPermissions, &encodedGrants, &item.RoleAssignmentsVersion, &item.ExpiresAt, &item.AcceptedAt, &item.RevokedAt, &item.EmailDeliveryStatus, &item.EmailSentAt, &item.EmailFailureCode); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(encodedRoles), &item.Roles); err != nil {
			return nil, fmt.Errorf("decode invitation roles: %w", err)
		}
		if err := json.Unmarshal([]byte(encodedPermissions), &item.GroupPermissions); err != nil {
			return nil, fmt.Errorf("decode invitation group permissions: %w", err)
		}
		if err := json.Unmarshal([]byte(encodedGrants), &item.CategoryGrants); err != nil {
			return nil, fmt.Errorf("decode invitation category grants: %w", err)
		}
		if item.Roles == nil {
			item.Roles = []domain.Role{}
		}
		if item.GroupPermissions == nil {
			item.GroupPermissions = []domain.GroupPermission{}
		}
		if item.CategoryGrants == nil {
			item.CategoryGrants = map[string][]domain.CategoryPermission{}
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for index := range result {
		result[index].RoleIDs, err = assignedRoleIDs(ctx, s.DB, membership.GroupID, domain.RoleAssignmentInvitation, result[index].ID)
		if err != nil {
			return nil, err
		}
		result[index].Roles, result[index].GroupPermissions, err = legacyAuthorizationForRoleIDs(ctx, s.DB, membership.GroupID, result[index].RoleIDs)
		if err != nil {
			return nil, err
		}
		result[index].CategoryGrants = map[string][]domain.CategoryPermission{}
	}
	return result, nil
}

func legacyAuthorizationForRoleIDs(ctx context.Context, queryer roleQueryer, groupID string, roleIDs []string) ([]domain.Role, []domain.GroupPermission, error) {
	selected := make(map[string]struct{}, len(roleIDs))
	for _, roleID := range roleIDs {
		selected[roleID] = struct{}{}
	}
	rows, err := queryer.QueryContext(ctx, `
		SELECT r.id,coalesce(r.preset_key,''),coalesce(g.permission_key,'')
		FROM roles r
		LEFT JOIN role_permission_grants g
		  ON g.group_id=r.group_id AND g.role_id=r.id AND g.scope_type='GROUP'
		WHERE r.group_id=?
		ORDER BY r.id,g.permission_key`, groupID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	hasReservedAdministrator := false
	grants := make([]domain.PermissionGrant, 0)
	for rows.Next() {
		var roleID string
		var preset domain.RolePresetKey
		var permission domain.PermissionKey
		if err := rows.Scan(&roleID, &preset, &permission); err != nil {
			return nil, nil, err
		}
		if _, assigned := selected[roleID]; !assigned {
			continue
		}
		if preset == domain.RolePresetGroupAdministrator {
			hasReservedAdministrator = true
		}
		if permission != "" {
			grants = append(grants, domain.PermissionGrant{Permission: permission, Scope: domain.PermissionScope{Type: domain.PermissionScopeGroup}})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	roles := authorization.LegacyRoles(hasReservedAdministrator, grants)
	permissions := make([]domain.GroupPermission, 0, 1)
	if _, assigned := selected["role:LEGACY_SELF_PAYMENT:"+groupID]; assigned {
		permissions = append(permissions, domain.PermissionSelfRecordPayment)
	}
	return roles, permissions, nil
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}
