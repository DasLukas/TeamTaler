package groups

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestGroupSettingsDefaultAuthorizationPersistenceAndAudit(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := authService.Bootstrap(ctx, "settings-admin@example.test", "Settings Admin", "settings-password-long", "Settings Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	session, err := authService.Login(ctx, "settings-admin@example.test", "settings-password-long")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	service := Service{DB: db}
	items, err := service.List(ctx, session.Principal.UserID)
	if err != nil || len(items) != 1 {
		t.Fatalf("list groups: groups=%d err=%v", len(items), err)
	}
	admin := items[0].Membership
	settings, err := service.Settings(ctx, admin)
	memberRoleID := authorization.PresetRoleID(admin.GroupID, domain.RolePresetMember)
	if err != nil || settings.NotificationEmailsEnabled || settings.SettlementsEnabled || settings.DefaultRoleID == nil || *settings.DefaultRoleID != memberRoleID {
		t.Fatalf("default settings=%#v err=%v", settings, err)
	}
	if !settings.ForeignBookingReasonRequired || !settings.OwnPaymentReasonRequired || settings.OtherPaymentReasonRequired || len(settings.PaymentMethods) != 4 {
		t.Fatalf("default transaction settings=%#v", settings)
	}
	wantDefaultMethods := []string{"BANK_TRANSFER", "CASH", "PAYPAL", "OTHER"}
	for index, method := range settings.PaymentMethods {
		if method.ID != wantDefaultMethods[index] {
			t.Fatalf("default payment method %d=%#v, want id %s", index, method, wantDefaultMethods[index])
		}
	}

	regularMember := admin
	regularMember.ID = "membership_without_group_administration"
	regularMember.Roles = nil
	if _, err := service.Settings(ctx, regularMember); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("regular-member settings read error=%v, want forbidden", err)
	}
	notifications := true
	if _, err := service.UpdateSettings(ctx, session.Principal, regularMember, SettingsUpdate{NotificationEmailsEnabled: &notifications}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("regular-member settings update error=%v, want forbidden", err)
	}

	updated, err := service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{NotificationEmailsEnabled: &notifications})
	if err != nil || !updated.NotificationEmailsEnabled {
		t.Fatalf("updated settings=%#v err=%v", updated, err)
	}
	notifications = false
	updated, err = service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{NotificationEmailsEnabled: &notifications})
	if err != nil || updated.NotificationEmailsEnabled {
		t.Fatalf("partial notification update=%#v err=%v", updated, err)
	}
	financeRoleID := authorization.PresetRoleID(admin.GroupID, domain.RolePresetFinanceManager)
	updated, err = service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{DefaultRoleID: &financeRoleID})
	if err != nil || updated.DefaultRoleID == nil || *updated.DefaultRoleID != financeRoleID {
		t.Fatalf("updated default role=%#v err=%v", updated, err)
	}
	administratorRoleID := authorization.PresetRoleID(admin.GroupID, domain.RolePresetGroupAdministrator)
	if _, err := service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{DefaultRoleID: &administratorRoleID}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("administrator default-role error=%v, want validation", err)
	}
	roles, err := service.ListRoles(ctx, admin)
	if err != nil {
		t.Fatalf("list roles: %v", err)
	}
	var financeRole ManagedRole
	for _, role := range roles {
		if role.ID == financeRoleID {
			financeRole = role
			break
		}
	}
	financeGrants := append([]domain.PermissionGrant(nil), financeRole.Grants...)
	groupAdministrationGrants := append(append([]domain.PermissionGrant(nil), financeGrants...), domain.PermissionGrant{Permission: domain.PermissionGroupAdministration, Scope: domain.PermissionScope{Type: domain.PermissionScopeGroup}})
	if _, err := service.UpdateRole(ctx, session.Principal, admin, financeRole.ID, financeRole.Version, RoleCommand{Name: financeRole.Name, Description: financeRole.Description, Grants: groupAdministrationGrants}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("administrator grant on default role error=%v, want validation", err)
	}
	memberManagementGrants := append(append([]domain.PermissionGrant(nil), financeGrants...), domain.PermissionGrant{Permission: domain.PermissionMemberManagement, Scope: domain.PermissionScope{Type: domain.PermissionScopeGroup}})
	if _, err := service.UpdateRole(ctx, session.Principal, admin, financeRole.ID, financeRole.Version, RoleCommand{Name: financeRole.Name, Description: financeRole.Description, Grants: memberManagementGrants}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("member-management grant on default role error=%v, want validation", err)
	}
	if err := service.DeleteRole(ctx, session.Principal, admin, financeRole.ID, financeRole.Version); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("delete default role error=%v, want conflict", err)
	}
	persisted, err := service.Settings(ctx, admin)
	if err != nil || persisted.NotificationEmailsEnabled || persisted.DefaultRoleID == nil || *persisted.DefaultRoleID != financeRoleID {
		t.Fatalf("persisted settings=%#v err=%v", persisted, err)
	}
	var auditCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM audit_events WHERE group_id=? AND action='group.settings.updated'`, admin.GroupID).Scan(&auditCount); err != nil || auditCount != 3 {
		t.Fatalf("settings audit count=%d err=%v, want three", auditCount, err)
	}
}

func TestTransactionSettingsAreOrderedEditableAndRequireOnePaymentMethod(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := authService.Bootstrap(ctx, "transaction-admin@example.test", "Transaction Admin", "transaction-password-long", "Transaction Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	session, err := authService.Login(ctx, "transaction-admin@example.test", "transaction-password-long")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	service := Service{DB: db}
	items, err := service.List(ctx, session.Principal.UserID)
	if err != nil || len(items) != 1 {
		t.Fatalf("list groups: groups=%d err=%v", len(items), err)
	}
	admin := items[0].Membership
	foreignBookingReasonRequired := false
	ownPaymentReasonRequired := false
	otherPaymentReasonRequired := true
	paymentMethods := []domain.ConfigurableItem{{ID: "CARD", Label: "Card"}, {ID: "CASH", Label: "Cash desk"}}
	bookingReasons := []domain.ConfigurableItem{{ID: "TEAM", Label: "Team event"}, {ID: "TRAVEL", Label: "Travel"}}
	paymentReasons := []domain.ConfigurableItem{{ID: "MONTHLY", Label: "Monthly settlement"}}
	updated, err := service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{
		ForeignBookingReasonRequired: &foreignBookingReasonRequired,
		OwnPaymentReasonRequired:     &ownPaymentReasonRequired,
		OtherPaymentReasonRequired:   &otherPaymentReasonRequired,
		PaymentMethods:               &paymentMethods,
		BookingReasons:               &bookingReasons,
		PaymentReasons:               &paymentReasons,
	})
	if err != nil {
		t.Fatalf("update transaction settings: %v", err)
	}
	if updated.ForeignBookingReasonRequired || updated.OwnPaymentReasonRequired || !updated.OtherPaymentReasonRequired {
		t.Fatalf("updated reason requirements=%#v", updated)
	}
	if len(updated.PaymentMethods) != 2 || updated.PaymentMethods[0].ID != "CARD" || updated.PaymentMethods[1].Label != "Cash desk" {
		t.Fatalf("updated payment methods=%#v", updated.PaymentMethods)
	}
	operational, err := service.TransactionSettings(ctx, admin)
	if err != nil || operational.SettlementsEnabled || len(operational.BookingReasons) != 2 || operational.BookingReasons[0].ID != "TEAM" || operational.PaymentReasons[0].ID != "MONTHLY" {
		t.Fatalf("operational transaction settings=%#v err=%v", operational, err)
	}
	empty := []domain.ConfigurableItem{}
	if _, err := service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{PaymentMethods: &empty}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("empty payment methods error=%v, want validation", err)
	}
	duplicates := []domain.ConfigurableItem{{ID: "ONE", Label: "Card"}, {ID: "TWO", Label: "card"}}
	if _, err := service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{PaymentMethods: &duplicates}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("duplicate payment methods error=%v, want validation", err)
	}
}
