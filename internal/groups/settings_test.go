package groups

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
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
	guestRoleID := authorization.GuestRoleID(admin.GroupID)
	if err != nil || settings.DefaultTheme != domain.ThemeTeamTaler || settings.NotificationEmailsEnabled || settings.SettlementsEnabled || settings.DefaultRoleID == nil || *settings.DefaultRoleID != guestRoleID {
		t.Fatalf("default settings=%#v err=%v", settings, err)
	}
	if !settings.ForeignBookingReasonRequired || !settings.OwnPaymentReasonRequired || settings.OtherPaymentReasonRequired || len(settings.PaymentMethods) != 5 {
		t.Fatalf("default transaction settings=%#v", settings)
	}
	if settings.OwnBookingReasonMode != domain.ReasonModeOff || settings.ForeignBookingReasonMode != domain.ReasonModeRequired ||
		settings.OwnPaymentReasonMode != domain.ReasonModeRequired || settings.OtherPaymentReasonMode != domain.ReasonModeOptional {
		t.Fatalf("default reason modes=%#v", settings)
	}
	wantDefaultMethods := []domain.PaymentMethod{
		{ID: "BANK_TRANSFER", Label: "Bank transfer", AttachmentMode: domain.AttachmentModeOff},
		{ID: "SHOPPING", Label: "Shopping", AttachmentMode: domain.AttachmentModeRequired},
		{ID: "CASH", Label: "Cash", AttachmentMode: domain.AttachmentModeOff},
		{ID: "PAYPAL", Label: "PayPal", AttachmentMode: domain.AttachmentModeOff},
		{ID: "OTHER", Label: "Other", AttachmentMode: domain.AttachmentModeOptional},
	}
	for index, method := range settings.PaymentMethods {
		if method != wantDefaultMethods[index] {
			t.Fatalf("default payment method %d=%#v, want %#v", index, method, wantDefaultMethods[index])
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
	nrwTheme := domain.ThemeNRW
	if _, err := service.UpdateSettings(ctx, session.Principal, regularMember, SettingsUpdate{DefaultTheme: &nrwTheme}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("regular-member theme update error=%v, want forbidden", err)
	}
	fireTheme := domain.ThemeFire
	updated, err := service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{DefaultTheme: &fireTheme})
	if err != nil || updated.DefaultTheme != domain.ThemeFire {
		t.Fatalf("updated default theme=%#v err=%v", updated, err)
	}

	updated, err = service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{NotificationEmailsEnabled: &notifications})
	if err != nil || !updated.NotificationEmailsEnabled {
		t.Fatalf("updated settings=%#v err=%v", updated, err)
	}
	notifications = false
	updated, err = service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{NotificationEmailsEnabled: &notifications})
	if err != nil || updated.NotificationEmailsEnabled {
		t.Fatalf("partial notification update=%#v err=%v", updated, err)
	}
	financeRoleID := authorization.TemplateRoleID(admin.GroupID, domain.RoleTemplateFinance)
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
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM audit_events WHERE group_id=? AND action='group.settings.updated'`, admin.GroupID).Scan(&auditCount); err != nil || auditCount != 4 {
		t.Fatalf("settings audit count=%d err=%v, want four", auditCount, err)
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
	ownBookingReasonMode := domain.ReasonModeOptional
	paymentMethods := []domain.PaymentMethod{{ID: "CARD", Label: "Card"}, {ID: "CASH", Label: "Cash desk"}}
	bookingReasons := []domain.ConfigurableItem{{ID: "TEAM", Label: "Team event"}, {ID: "TRAVEL", Label: "Travel"}}
	paymentReasons := []domain.ConfigurableItem{{ID: "MONTHLY", Label: "Monthly settlement"}}
	updated, err := service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{
		OwnBookingReasonMode:         &ownBookingReasonMode,
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
	if updated.OwnBookingReasonMode != domain.ReasonModeOptional || updated.ForeignBookingReasonMode != domain.ReasonModeOptional ||
		updated.OwnPaymentReasonMode != domain.ReasonModeOptional || updated.OtherPaymentReasonMode != domain.ReasonModeRequired {
		t.Fatalf("updated reason modes=%#v", updated)
	}
	if len(updated.PaymentMethods) != 2 || updated.PaymentMethods[0].ID != "CARD" || updated.PaymentMethods[1].Label != "Cash desk" {
		t.Fatalf("updated payment methods=%#v", updated.PaymentMethods)
	}
	operational, err := service.TransactionSettings(ctx, admin)
	if err != nil || operational.SettlementsEnabled || len(operational.BookingReasons) != 2 || operational.BookingReasons[0].ID != "TEAM" || operational.PaymentReasons[0].ID != "MONTHLY" {
		t.Fatalf("operational transaction settings=%#v err=%v", operational, err)
	}
	empty := []domain.PaymentMethod{}
	if _, err := service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{PaymentMethods: &empty}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("empty payment methods error=%v, want validation", err)
	}
	duplicates := []domain.PaymentMethod{{ID: "ONE", Label: "Card"}, {ID: "TWO", Label: "card"}}
	if _, err := service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{PaymentMethods: &duplicates}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("duplicate payment methods error=%v, want validation", err)
	}
	invalidMode := domain.ReasonMode("MAYBE")
	if _, err := service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{OwnBookingReasonMode: &invalidMode}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("invalid reason mode error=%v, want validation", err)
	}
}

func TestPaymentTargetsPersistAndPatchPresencePreservesByStableMethodID(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := authService.Bootstrap(ctx, "targets-admin@example.test", "Targets Admin", "targets-password-long", "Targets Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	session, err := authService.Login(ctx, "targets-admin@example.test", "targets-password-long")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	service := Service{DB: db}
	groups, err := service.List(ctx, session.Principal.UserID)
	if err != nil || len(groups) != 1 {
		t.Fatalf("list groups: groups=%d err=%v", len(groups), err)
	}
	admin := groups[0].Membership
	settings, err := service.Settings(ctx, admin)
	if err != nil {
		t.Fatalf("read settings: %v", err)
	}
	for index := range settings.PaymentMethods {
		switch settings.PaymentMethods[index].ID {
		case "PAYPAL":
			settings.PaymentMethods[index].PaymentTarget = &domain.PaymentTarget{Type: domain.PaymentTargetPayPalMe, PayPalMeHandle: "https://paypal.me/Club123"}
		case "BANK_TRANSFER":
			settings.PaymentMethods[index].PaymentTarget = &domain.PaymentTarget{Type: domain.PaymentTargetSEPATransfer,
				RecipientName: " Team Club ", IBAN: "de89 3704 0044 0532 0130 00", BIC: "cobadeffxxx"}
		}
	}
	configured, err := service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{PaymentMethods: &settings.PaymentMethods})
	if err != nil {
		t.Fatalf("configure payment targets: %v", err)
	}
	if configured.PaymentMethods[0].PaymentTarget == nil || configured.PaymentMethods[0].PaymentTarget.IBAN != "DE89370400440532013000" {
		t.Fatalf("normalized bank target = %#v", configured.PaymentMethods[0].PaymentTarget)
	}

	legacyMethods := make([]domain.PaymentMethod, 0, len(configured.PaymentMethods)+1)
	legacyMethods = append(legacyMethods, domain.PaymentMethod{ID: "PAYPAL", Label: "PayPal private", AttachmentMode: domain.AttachmentModeOff})
	for _, method := range configured.PaymentMethods {
		if method.ID != "PAYPAL" {
			legacyMethods = append(legacyMethods, domain.PaymentMethod{ID: method.ID, Label: method.Label, AttachmentMode: method.AttachmentMode})
		}
	}
	legacyMethods = append(legacyMethods, domain.PaymentMethod{ID: "CARD", Label: "Card", AttachmentMode: domain.AttachmentModeOff})
	missingTargets := make([]bool, len(legacyMethods))
	preserved, err := service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{PaymentMethods: &legacyMethods, PaymentTargetsSpecified: missingTargets})
	if err != nil {
		t.Fatalf("legacy payment-method patch: %v", err)
	}
	if preserved.PaymentMethods[0].PaymentTarget == nil || preserved.PaymentMethods[0].PaymentTarget.PayPalMeHandle != "Club123" {
		t.Fatalf("preserved PayPal target = %#v", preserved.PaymentMethods[0].PaymentTarget)
	}
	if preserved.PaymentMethods[len(preserved.PaymentMethods)-1].PaymentTarget != nil {
		t.Fatalf("new omitted target = %#v, want nil", preserved.PaymentMethods[len(preserved.PaymentMethods)-1].PaymentTarget)
	}

	clearPayPal := make([]domain.PaymentMethod, len(preserved.PaymentMethods))
	clearPresence := make([]bool, len(preserved.PaymentMethods))
	for index, method := range preserved.PaymentMethods {
		clearPayPal[index] = domain.PaymentMethod{ID: method.ID, Label: method.Label, AttachmentMode: method.AttachmentMode}
		if method.ID == "PAYPAL" {
			clearPresence[index] = true
		}
	}
	cleared, err := service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{PaymentMethods: &clearPayPal, PaymentTargetsSpecified: clearPresence})
	if err != nil {
		t.Fatalf("clear PayPal target: %v", err)
	}
	var bankTarget, payPalTarget *domain.PaymentTarget
	for _, method := range cleared.PaymentMethods {
		switch method.ID {
		case "BANK_TRANSFER":
			bankTarget = method.PaymentTarget
		case "PAYPAL":
			payPalTarget = method.PaymentTarget
		}
	}
	if payPalTarget != nil || bankTarget == nil || bankTarget.IBAN != "DE89370400440532013000" {
		t.Fatalf("cleared/preserved targets = PayPal %#v, bank %#v", payPalTarget, bankTarget)
	}
	operational, err := service.TransactionSettings(ctx, admin)
	if err != nil || len(operational.PaymentMethods) != len(cleared.PaymentMethods) {
		t.Fatalf("transaction settings = %#v, %v", operational, err)
	}

	var auditMetadata string
	if err := db.QueryRowContext(ctx, `SELECT group_concat(metadata_json,'') FROM audit_events WHERE group_id=? AND action='group.settings.updated'`, admin.GroupID).Scan(&auditMetadata); err != nil {
		t.Fatalf("read settings audit: %v", err)
	}
	for _, secret := range []string{"Club123", "Team Club", "DE89370400440532013000", "COBADEFFXXX"} {
		if strings.Contains(auditMetadata, secret) {
			t.Fatalf("settings audit leaked payment target data %q: %s", secret, auditMetadata)
		}
	}
	if !strings.Contains(auditMetadata, "paymentTargetCount") || !strings.Contains(auditMetadata, "SEPA_TRANSFER") {
		t.Fatalf("settings audit lacks redacted target summary: %s", auditMetadata)
	}

	badPresence := []bool{true}
	if _, err := service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{PaymentMethods: &clearPayPal, PaymentTargetsSpecified: badPresence}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("inconsistent target presence error = %v, want validation", err)
	}
}
