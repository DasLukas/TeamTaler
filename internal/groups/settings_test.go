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
	if items[0].StatisticsEnabled || items[0].ExternalAccountsEnabled {
		t.Fatal("new group unexpectedly enabled an optional feature")
	}
	settings, err := service.Settings(ctx, admin)
	guestRoleID := authorization.GuestRoleID(admin.GroupID)
	if err != nil || settings.DefaultTheme != domain.ThemeTeamTaler || settings.StatisticsEnabled || settings.ExternalAccountsEnabled || settings.ExternalAccountsVersion != 1 || settings.SettlementsEnabled || settings.SettlementDueSoonDays != 3 || settings.SettlementOverdueRepeatDays != 7 || settings.DefaultRoleID == nil || *settings.DefaultRoleID != guestRoleID {
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
	dueSoonDays := 5
	if _, err := service.UpdateSettings(ctx, session.Principal, regularMember, SettingsUpdate{SettlementDueSoonDays: &dueSoonDays}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("regular-member settings update error=%v, want forbidden", err)
	}
	statisticsEnabled := true
	if _, err := service.UpdateSettings(ctx, session.Principal, regularMember, SettingsUpdate{StatisticsEnabled: &statisticsEnabled}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("regular-member statistics update error=%v, want forbidden", err)
	}
	externalAccountsEnabled := true
	if _, err := service.UpdateSettings(ctx, session.Principal, regularMember, SettingsUpdate{ExternalAccountsEnabled: &externalAccountsEnabled}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("regular-member external-account update error=%v, want forbidden", err)
	}
	kioskEnabled := true
	if _, err := service.UpdateSettings(ctx, session.Principal, regularMember, SettingsUpdate{KioskEnabled: &kioskEnabled}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("regular-member kiosk update error=%v, want forbidden", err)
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

	updated, err = service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{SettlementDueSoonDays: &dueSoonDays})
	if err != nil || updated.SettlementDueSoonDays != 5 {
		t.Fatalf("updated settings=%#v err=%v", updated, err)
	}
	dueSoonDays = 3
	updated, err = service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{SettlementDueSoonDays: &dueSoonDays})
	if err != nil || updated.SettlementDueSoonDays != 3 {
		t.Fatalf("partial reminder update=%#v err=%v", updated, err)
	}
	financeRoleID := authorization.TemplateRoleID(admin.GroupID, domain.RoleTemplateFinance)
	updated, err = service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{DefaultRoleID: &financeRoleID})
	if err != nil || updated.DefaultRoleID == nil || *updated.DefaultRoleID != financeRoleID {
		t.Fatalf("updated default role=%#v err=%v", updated, err)
	}
	updated, err = service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{StatisticsEnabled: &statisticsEnabled})
	if err != nil || !updated.StatisticsEnabled {
		t.Fatalf("updated statistics setting=%#v err=%v", updated, err)
	}
	updated, err = service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{ExternalAccountsEnabled: &externalAccountsEnabled})
	if err != nil || !updated.ExternalAccountsEnabled {
		t.Fatalf("updated external-account setting=%#v err=%v", updated, err)
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
	if err != nil || !persisted.StatisticsEnabled || !persisted.ExternalAccountsEnabled || persisted.SettlementDueSoonDays != 3 || persisted.DefaultRoleID == nil || *persisted.DefaultRoleID != financeRoleID {
		t.Fatalf("persisted settings=%#v err=%v", persisted, err)
	}
	var auditCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM audit_events WHERE group_id=? AND action='group.settings.updated'`, admin.GroupID).Scan(&auditCount); err != nil || auditCount != 6 {
		t.Fatalf("settings audit count=%d err=%v, want six", auditCount, err)
	}
	listed, err := service.List(ctx, session.Principal.UserID)
	if err != nil || len(listed) != 1 || !listed[0].StatisticsEnabled || !listed[0].ExternalAccountsEnabled {
		t.Fatalf("group statistics projection=%#v err=%v", listed, err)
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
	if configured.PaymentMethods[0].ExternalAccountID == nil || configured.ExternalAccountsVersion != settings.ExternalAccountsVersion+1 {
		t.Fatalf("configured account link/version = %#v/%d", configured.PaymentMethods[0].ExternalAccountID, configured.ExternalAccountsVersion)
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
	var bookedPayPalAccountID string
	for _, method := range preserved.PaymentMethods {
		if method.ID == "PAYPAL" && method.ExternalAccountID != nil {
			bookedPayPalAccountID = *method.ExternalAccountID
		}
	}
	if bookedPayPalAccountID == "" {
		t.Fatal("configured PayPal account link is missing")
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO external_account_transactions(
		id,group_id,kind,primary_account_id,amount_minor,booked_at,reason,created_by_membership_id,created_at
	) VALUES('target-history',?,'INCOME',?,100,'2026-09-01T00:00:00Z','History fixture',?,'2026-09-01T00:00:00Z')`, admin.GroupID, bookedPayPalAccountID, admin.ID); err != nil {
		t.Fatalf("insert booked target transaction: %v", err)
	}
	for _, ledger := range []struct {
		id, account, externalAccountID string
		amount                         int64
	}{
		{id: "target-history-account", account: "EXTERNAL_ACCOUNT", externalAccountID: bookedPayPalAccountID, amount: 100},
		{id: "target-history-offset", account: "EXTERNAL_OFFSET", amount: -100},
	} {
		if _, err := db.ExecContext(ctx, `INSERT INTO ledger_entries(
			id,group_id,period_id,external_account_id,external_transaction_id,account,amount_minor,description,created_at
		) VALUES(?,?,(SELECT id FROM periods WHERE group_id=? AND status='OPEN'),nullif(?,''),'target-history',?,?,?,?)`, ledger.id, admin.GroupID, admin.GroupID, ledger.externalAccountID, ledger.account, ledger.amount, "History fixture", "2026-09-01T00:00:00Z"); err != nil {
			t.Fatalf("insert booked target ledger: %v", err)
		}
	}
	changedTargetMethods := append([]domain.PaymentMethod(nil), preserved.PaymentMethods...)
	changedTargetPresence := make([]bool, len(changedTargetMethods))
	for index := range changedTargetMethods {
		if changedTargetMethods[index].ID == "PAYPAL" {
			changedTargetMethods[index].PaymentTarget = &domain.PaymentTarget{Type: domain.PaymentTargetPayPalMe, PayPalMeHandle: "Club456"}
			changedTargetMethods[index].ExternalAccountID = nil
			changedTargetPresence[index] = true
		}
	}
	preserved, err = service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{PaymentMethods: &changedTargetMethods, PaymentTargetsSpecified: changedTargetPresence})
	if err != nil {
		t.Fatalf("replace target backed by booked account: %v", err)
	}
	var replacementPayPalAccountID string
	for _, method := range preserved.PaymentMethods {
		if method.ID == "PAYPAL" && method.ExternalAccountID != nil {
			replacementPayPalAccountID = *method.ExternalAccountID
		}
	}
	if replacementPayPalAccountID == "" || replacementPayPalAccountID == bookedPayPalAccountID {
		t.Fatalf("booked PayPal account was rewritten in place: old=%q replacement=%q", bookedPayPalAccountID, replacementPayPalAccountID)
	}
	var historicalHandle string
	if err := db.QueryRowContext(ctx, `SELECT paypal_me_handle FROM external_accounts WHERE group_id=? AND id=?`, admin.GroupID, bookedPayPalAccountID).Scan(&historicalHandle); err != nil || historicalHandle != "Club123" {
		t.Fatalf("historical PayPal target changed: handle=%q err=%v", historicalHandle, err)
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
	var bankAccountID, payPalAccountID *string
	for _, method := range cleared.PaymentMethods {
		switch method.ID {
		case "BANK_TRANSFER":
			bankTarget = method.PaymentTarget
			bankAccountID = method.ExternalAccountID
		case "PAYPAL":
			payPalTarget = method.PaymentTarget
			payPalAccountID = method.ExternalAccountID
		}
	}
	if payPalTarget != nil || payPalAccountID != nil || bankTarget == nil || bankAccountID == nil || bankTarget.IBAN != "DE89370400440532013000" {
		t.Fatalf("cleared/preserved targets = PayPal %#v/%#v, bank %#v/%#v", payPalTarget, payPalAccountID, bankTarget, bankAccountID)
	}
	operational, err := service.TransactionSettings(ctx, admin)
	if err != nil || len(operational.PaymentMethods) != len(cleared.PaymentMethods) {
		t.Fatalf("transaction settings = %#v, %v", operational, err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE external_accounts SET status='ARCHIVED' WHERE group_id=? AND id=?`, admin.GroupID, bookedPayPalAccountID); err != nil {
		t.Fatalf("archive unlinked target account: %v", err)
	}
	archivedTargetMethods := append([]domain.PaymentMethod(nil), cleared.PaymentMethods...)
	archivedTargetPresence := make([]bool, len(archivedTargetMethods))
	for index := range archivedTargetMethods {
		if archivedTargetMethods[index].ID == "PAYPAL" {
			archivedTargetMethods[index].PaymentTarget = &domain.PaymentTarget{Type: domain.PaymentTargetPayPalMe, PayPalMeHandle: "Club123"}
			archivedTargetPresence[index] = true
		}
	}
	if _, err := service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{PaymentMethods: &archivedTargetMethods, PaymentTargetsSpecified: archivedTargetPresence}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("link matching archived target error=%v, want conflict", err)
	}

	var auditMetadata string
	if err := db.QueryRowContext(ctx, `SELECT group_concat(metadata_json,'') FROM audit_events WHERE group_id=? AND action='group.settings.updated'`, admin.GroupID).Scan(&auditMetadata); err != nil {
		t.Fatalf("read settings audit: %v", err)
	}
	for _, secret := range []string{"Club123", "Club456", "Team Club", "DE89370400440532013000", "COBADEFFXXX"} {
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

func TestLegacyBankTargetChangesRemainDistinctAcrossFeatureToggle(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := authService.Bootstrap(ctx, "legacy-targets@example.test", "Targets Admin", "targets-password-long", "Targets Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	session, err := authService.Login(ctx, "legacy-targets@example.test", "targets-password-long")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	service := Service{DB: db}
	groups, err := service.List(ctx, session.Principal.UserID)
	if err != nil || len(groups) != 1 {
		t.Fatalf("list groups: %v, count=%d", err, len(groups))
	}
	admin := groups[0].Membership
	settings, err := service.Settings(ctx, admin)
	if err != nil {
		t.Fatalf("read settings: %v", err)
	}
	for index := range settings.PaymentMethods {
		if settings.PaymentMethods[index].ID == "BANK_TRANSFER" || settings.PaymentMethods[index].ID == "OTHER" {
			settings.PaymentMethods[index].PaymentTarget = &domain.PaymentTarget{Type: domain.PaymentTargetSEPATransfer, RecipientName: "Main club", IBAN: "DE89370400440532013000", BIC: "COBADEFFXXX"}
		}
	}
	configured, err := service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{PaymentMethods: &settings.PaymentMethods})
	if err != nil {
		t.Fatalf("configure matching bank targets: %v", err)
	}
	var sharedAccountID string
	for _, method := range configured.PaymentMethods {
		if method.ID == "BANK_TRANSFER" || method.ID == "OTHER" {
			if method.ExternalAccountID == nil {
				t.Fatalf("%s has no account link", method.ID)
			}
			if sharedAccountID == "" {
				sharedAccountID = *method.ExternalAccountID
			} else if *method.ExternalAccountID != sharedAccountID {
				t.Fatalf("matching targets linked to distinct accounts")
			}
		}
	}
	enabled := true
	if _, err := service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{ExternalAccountsEnabled: &enabled}); err != nil {
		t.Fatalf("enable accounts: %v", err)
	}
	enabled = false
	if _, err := service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{ExternalAccountsEnabled: &enabled}); err != nil {
		t.Fatalf("disable accounts: %v", err)
	}
	methods := append([]domain.PaymentMethod(nil), configured.PaymentMethods...)
	targetSpecified := make([]bool, len(methods))
	accountSpecified := make([]bool, len(methods))
	for index := range methods {
		targetSpecified[index] = true
		accountSpecified[index] = true
		if methods[index].ID == "BANK_TRANSFER" {
			methods[index].PaymentTarget = &domain.PaymentTarget{Type: domain.PaymentTargetSEPATransfer, RecipientName: "Youth club", IBAN: "DE89370400440532013000", BIC: "DEUTDEFFXXX"}
			methods[index].ExternalAccountID = nil
			accountSpecified[index] = false
		}
	}
	updated, err := service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{PaymentMethods: &methods, PaymentTargetsSpecified: targetSpecified, ExternalAccountIDsSpecified: accountSpecified})
	if err != nil {
		t.Fatalf("change one legacy bank target: %v", err)
	}
	var changedAccountID string
	for _, method := range updated.PaymentMethods {
		if method.ID == "BANK_TRANSFER" {
			if method.ExternalAccountID == nil || method.PaymentTarget == nil || method.PaymentTarget.RecipientName != "Youth club" || method.PaymentTarget.BIC != "DEUTDEFFXXX" {
				t.Fatalf("changed bank target=%#v", method)
			}
			changedAccountID = *method.ExternalAccountID
		} else if method.ID == "OTHER" && (method.ExternalAccountID == nil || *method.ExternalAccountID != sharedAccountID || method.PaymentTarget == nil || method.PaymentTarget.RecipientName != "Main club") {
			t.Fatalf("unchanged shared target=%#v", method)
		}
	}
	if changedAccountID == sharedAccountID {
		t.Fatal("changed target reused the shared account")
	}
	persisted, err := service.Settings(ctx, admin)
	if err != nil || persisted.ExternalAccountsEnabled {
		t.Fatalf("persisted disabled settings=%#v err=%v", persisted, err)
	}
	for _, method := range persisted.PaymentMethods {
		if method.ID == "BANK_TRANSFER" && (method.PaymentTarget == nil || method.PaymentTarget.RecipientName != "Youth club") {
			t.Fatalf("reloaded bank target=%#v", method.PaymentTarget)
		}
	}
}

func TestRemovingLinkedPaymentMethodPersistsAndUnlinksExternalAccount(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := authService.Bootstrap(ctx, "remove-method-admin@example.test", "Settings Admin", "settings-password-long", "Settings Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	session, err := authService.Login(ctx, "remove-method-admin@example.test", "settings-password-long")
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
		if settings.PaymentMethods[index].ID == "BANK_TRANSFER" {
			settings.PaymentMethods[index].PaymentTarget = &domain.PaymentTarget{
				Type: domain.PaymentTargetSEPATransfer, RecipientName: "Team Club", IBAN: "DE89370400440532013000",
			}
		}
	}
	linked, err := service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{PaymentMethods: &settings.PaymentMethods})
	if err != nil {
		t.Fatalf("link payment method: %v", err)
	}
	var accountID string
	remaining := make([]domain.PaymentMethod, 0, len(linked.PaymentMethods)-1)
	for _, method := range linked.PaymentMethods {
		if method.ID == "BANK_TRANSFER" {
			if method.ExternalAccountID == nil {
				t.Fatal("linked payment method has no external account")
			}
			accountID = *method.ExternalAccountID
			continue
		}
		remaining = append(remaining, method)
	}
	if _, err := service.UpdateSettings(ctx, session.Principal, admin, SettingsUpdate{PaymentMethods: &remaining}); err != nil {
		t.Fatalf("remove linked payment method: %v", err)
	}
	reloaded, err := service.Settings(ctx, admin)
	if err != nil {
		t.Fatalf("reload settings: %v", err)
	}
	for _, method := range reloaded.PaymentMethods {
		if method.ID == "BANK_TRANSFER" {
			t.Fatal("removed payment method returned after reload")
		}
	}
	var accountCount, linkCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM external_accounts WHERE group_id=? AND id=?`, admin.GroupID, accountID).Scan(&accountCount); err != nil {
		t.Fatalf("count external account: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM group_payment_methods WHERE group_id=? AND external_account_id=?`, admin.GroupID, accountID).Scan(&linkCount); err != nil {
		t.Fatalf("count payment method links: %v", err)
	}
	if accountCount != 1 || linkCount != 0 {
		t.Fatalf("account/link count after removal = %d/%d, want 1/0", accountCount, linkCount)
	}
}
