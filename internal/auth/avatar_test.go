package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestAvatarLifecyclePropagatesToSessionsAndMemberships(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()

	service := Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := service.Bootstrap(ctx, "avatar@example.test", "Avatar Admin", "avatar-test-password-long", "Avatar Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	session, err := service.Login(ctx, "avatar@example.test", "avatar-test-password-long")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if _, _, err := service.SetAvatar(ctx, session.Principal, "unsafe.png"); err == nil {
		t.Fatal("invalid image key was accepted")
	}

	digest := sha256.Sum256([]byte("avatar-fixture"))
	imageKey := hex.EncodeToString(digest[:]) + ".png"
	wantURL := "/api/v1/users/" + session.Principal.UserID + "/avatar/" + imageKey
	avatarURL, replacedKey, err := service.SetAvatar(ctx, session.Principal, imageKey)
	if err != nil || avatarURL != wantURL || replacedKey != "" {
		t.Fatalf("set avatar: url=%q replaced=%q err=%v", avatarURL, replacedKey, err)
	}

	authenticated, err := service.Authenticate(ctx, session.Token, session.CSRFToken)
	if err != nil || authenticated.AvatarURL != wantURL {
		t.Fatalf("authenticated avatar URL=%q err=%v", authenticated.AvatarURL, err)
	}
	groupItems, err := (groups.Service{DB: db}).List(ctx, session.Principal.UserID)
	if err != nil || len(groupItems) != 1 || groupItems[0].Membership.AvatarURL != wantURL {
		t.Fatalf("membership avatar: groups=%#v err=%v", groupItems, err)
	}

	removedKey, err := service.RemoveAvatar(ctx, session.Principal)
	if err != nil || removedKey != imageKey {
		t.Fatalf("remove avatar: key=%q err=%v", removedKey, err)
	}
	authenticated, err = service.Authenticate(ctx, session.Token, session.CSRFToken)
	if err != nil || authenticated.AvatarURL != "" {
		t.Fatalf("removed authenticated avatar URL=%q err=%v", authenticated.AvatarURL, err)
	}
}
