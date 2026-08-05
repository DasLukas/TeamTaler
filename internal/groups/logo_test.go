package groups

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestUpdateGroupSettings(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := authService.Bootstrap(ctx, "logo-admin@example.test", "Logo Admin", "logo-test-password-long", "Logo Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	session, err := authService.Login(ctx, "logo-admin@example.test", "logo-test-password-long")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	service := Service{DB: db}
	items, err := service.List(ctx, session.Principal.UserID)
	if err != nil || len(items) != 1 {
		t.Fatalf("list groups: groups=%d err=%v", len(items), err)
	}
	group := items[0]
	updatedName, err := service.UpdateName(ctx, session.Principal, group.Membership, "  Renamed Group  ")
	if err != nil || updatedName != "Renamed Group" {
		t.Fatalf("update group name: name=%q err=%v", updatedName, err)
	}
	items, err = service.List(ctx, session.Principal.UserID)
	if err != nil || items[0].Name != "Renamed Group" {
		t.Fatalf("listed group name = %q err=%v", items[0].Name, err)
	}
	var auditCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM audit_events WHERE group_id=? AND action='group.name.updated'`, group.ID).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatalf("group-name audit count = %d err=%v", auditCount, err)
	}
	unauthorized := group.Membership
	unauthorized.Roles = nil
	if _, err := service.UpdateName(ctx, session.Principal, unauthorized, "Forbidden Name"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("non-admin update name error = %v, want forbidden", err)
	}
	for _, invalidName := range []string{"", "Invalid\nName", strings.Repeat("a", 121)} {
		if _, err := service.UpdateName(ctx, session.Principal, group.Membership, invalidName); !errors.Is(err, domain.ErrValidation) {
			t.Fatalf("invalid group name %q error = %v, want validation", invalidName, err)
		}
	}
	imageKey := strings.Repeat("a", 64) + ".png"
	logoURL, replacedKey, err := service.SetLogo(ctx, session.Principal, group.Membership, imageKey)
	if err != nil || replacedKey != "" {
		t.Fatalf("set logo: url=%q replaced=%q err=%v", logoURL, replacedKey, err)
	}
	wantURL := "/api/v1/groups/" + group.ID + "/images/" + imageKey
	if logoURL != wantURL {
		t.Fatalf("logo URL = %q, want %q", logoURL, wantURL)
	}
	items, err = service.List(ctx, session.Principal.UserID)
	if err != nil || items[0].LogoURL != wantURL {
		t.Fatalf("listed logo URL = %q err=%v", items[0].LogoURL, err)
	}
	if _, _, err := service.SetLogo(ctx, session.Principal, unauthorized, strings.Repeat("b", 64)+".png"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("non-admin set logo error = %v, want forbidden", err)
	}
	if _, _, err := service.SetLogo(ctx, session.Principal, group.Membership, "../unsafe.png"); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("unsafe logo key error = %v, want validation", err)
	}
	removedKey, err := service.RemoveLogo(ctx, session.Principal, group.Membership)
	if err != nil || removedKey != imageKey {
		t.Fatalf("remove logo: removed=%q err=%v", removedKey, err)
	}
	items, err = service.List(ctx, session.Principal.UserID)
	if err != nil || items[0].LogoURL != "" {
		t.Fatalf("logo remained after removal: url=%q err=%v", items[0].LogoURL, err)
	}
}
