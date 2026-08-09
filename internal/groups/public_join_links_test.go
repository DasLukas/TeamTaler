package groups

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestPublicJoinLinkLifecycleUsesVersionedEncryptedTokens(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "public-join-links.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()

	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := authService.Bootstrap(ctx, "admin@example.test", "Admin", "correct-horse-battery-staple", "Join Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	session, err := authService.Login(ctx, "admin@example.test", "correct-horse-battery-staple")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	box, err := platform.NewSecretBox([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("secret box: %v", err)
	}
	service := Service{DB: db, TokenSealer: box, TokenOpener: box, EmailDeliveryAvailable: true}
	groupItems, err := service.List(ctx, session.Principal.UserID)
	if err != nil || len(groupItems) != 1 {
		t.Fatalf("list groups: groups=%d err=%v", len(groupItems), err)
	}
	membership := groupItems[0].Membership

	initial, err := service.GetPublicJoinLink(ctx, membership)
	if err != nil || initial.Version != 0 || initial.Enabled || !initial.EmailVerificationAvailable {
		t.Fatalf("initial link=%#v err=%v", initial, err)
	}
	created, err := service.PutPublicJoinLink(ctx, session.Principal, membership, true, nil, initial.Version)
	if err != nil || created.Version != 1 || !created.Enabled || created.Expired || created.ExpiresAt != nil || created.Token == "" {
		t.Fatalf("created link=%#v err=%v", created, err)
	}
	var encryptedToken, tokenHash string
	if err := db.QueryRowContext(ctx, `SELECT token_ciphertext,token_hash FROM public_join_links WHERE group_id=?`, membership.GroupID).Scan(&encryptedToken, &tokenHash); err != nil {
		t.Fatalf("read persisted token: %v", err)
	}
	opened, err := box.Open(encryptedToken)
	if err != nil || opened != created.Token || platform.HashSecret(opened) != tokenHash || encryptedToken == opened {
		t.Fatalf("persisted token does not match encrypted link: opened=%q err=%v", opened, err)
	}

	rotated, err := service.RotatePublicJoinLink(ctx, session.Principal, membership, created.Version)
	if err != nil || rotated.Version != 2 || rotated.Token == "" || rotated.Token == created.Token {
		t.Fatalf("rotated link=%#v err=%v", rotated, err)
	}
	if _, err := service.RotatePublicJoinLink(ctx, session.Principal, membership, created.Version); !errors.Is(err, domain.ErrPrecondition) {
		t.Fatalf("stale rotation error=%v, want precondition", err)
	}

	disabled, err := service.PutPublicJoinLink(ctx, session.Principal, membership, false, nil, rotated.Version)
	if err != nil || disabled.Version != 3 || disabled.Enabled || disabled.Token != "" {
		t.Fatalf("disabled link=%#v err=%v", disabled, err)
	}
	var persistedTokenCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM public_join_links WHERE group_id=? AND token_hash IS NOT NULL`, membership.GroupID).Scan(&persistedTokenCount); err != nil || persistedTokenCount != 0 {
		t.Fatalf("persisted token count=%d err=%v, want zero", persistedTokenCount, err)
	}
}

func TestPublicJoinLinkRejectsUnavailableDeliveryAndUnauthorizedMember(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "public-join-authorization.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := authService.Bootstrap(ctx, "admin@example.test", "Admin", "correct-horse-battery-staple", "Join Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	session, err := authService.Login(ctx, "admin@example.test", "correct-horse-battery-staple")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	service := Service{DB: db}
	groupItems, err := service.List(ctx, session.Principal.UserID)
	if err != nil || len(groupItems) != 1 {
		t.Fatalf("list groups: groups=%d err=%v", len(groupItems), err)
	}
	membership := groupItems[0].Membership
	if _, err := service.PutPublicJoinLink(ctx, session.Principal, membership, true, nil, 0); !errors.Is(err, domain.ErrServiceUnavailable) {
		t.Fatalf("unavailable delivery error=%v, want service unavailable", err)
	}

	unauthorized := membership
	unauthorized.ID = "membership-without-permissions"
	if _, err := service.GetPublicJoinLink(ctx, unauthorized); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("unauthorized read error=%v, want forbidden", err)
	}
}
