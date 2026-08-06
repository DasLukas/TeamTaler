package groups

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
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
	if err != nil || settings.MembersCanViewAllBookings {
		t.Fatalf("default settings=%#v err=%v", settings, err)
	}

	regularMember := admin
	regularMember.Roles = nil
	if _, err := service.Settings(ctx, regularMember); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("regular-member settings read error=%v, want forbidden", err)
	}
	if _, err := service.UpdateSettings(ctx, session.Principal, regularMember, domain.GroupSettings{MembersCanViewAllBookings: true}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("regular-member settings update error=%v, want forbidden", err)
	}

	updated, err := service.UpdateSettings(ctx, session.Principal, admin, domain.GroupSettings{MembersCanViewAllBookings: true, NotificationEmailsEnabled: true})
	if err != nil || !updated.MembersCanViewAllBookings || !updated.NotificationEmailsEnabled {
		t.Fatalf("updated settings=%#v err=%v", updated, err)
	}
	persisted, err := service.Settings(ctx, admin)
	if err != nil || !persisted.MembersCanViewAllBookings || !persisted.NotificationEmailsEnabled {
		t.Fatalf("persisted settings=%#v err=%v", persisted, err)
	}
	var auditCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM audit_events WHERE group_id=? AND action='group.settings.updated'`, admin.GroupID).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatalf("settings audit count=%d err=%v, want one", auditCount, err)
	}
}
