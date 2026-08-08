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
	if err != nil || settings.NotificationEmailsEnabled || settings.DefaultRoleID == nil || *settings.DefaultRoleID != memberRoleID {
		t.Fatalf("default settings=%#v err=%v", settings, err)
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
	financeRole.Grants = append(financeRole.Grants, domain.PermissionGrant{Permission: domain.PermissionGroupAdministration, Scope: domain.PermissionScope{Type: domain.PermissionScopeGroup}})
	if _, err := service.UpdateRole(ctx, session.Principal, admin, financeRole.ID, financeRole.Version, RoleCommand{Name: financeRole.Name, Description: financeRole.Description, Grants: financeRole.Grants}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("administrator grant on default role error=%v, want validation", err)
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
