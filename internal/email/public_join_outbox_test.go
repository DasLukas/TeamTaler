package email

import (
	"context"
	"database/sql"
	"io"
	"log/slog"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestPublicJoinDispatcherSendsProofAndClearsCiphertext(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "public-join-outbox.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	box, err := platform.NewSecretBox([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("secret box: %v", err)
	}
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour, TokenSealer: box, EmailDeliveryAvailable: true}
	if err := authService.Bootstrap(ctx, "admin@example.test", "Admin", "correct-horse-battery-staple", "Email Join Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	adminSession, err := authService.Login(ctx, "admin@example.test", "correct-horse-battery-staple")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	groupService := groups.Service{DB: db, TokenSealer: box, TokenOpener: box, EmailDeliveryAvailable: true}
	groupItems, err := groupService.List(ctx, adminSession.Principal.UserID)
	if err != nil || len(groupItems) != 1 {
		t.Fatalf("list groups: groups=%d err=%v", len(groupItems), err)
	}
	link, err := groupService.PutPublicJoinLink(ctx, adminSession.Principal, groupItems[0].Membership, true, nil, 0)
	if err != nil {
		t.Fatalf("create public join link: %v", err)
	}
	if err := authService.StartPublicJoinRegistration(ctx, auth.PublicJoinRegistration{
		JoinToken: link.Token, Email: "new@example.test", DisplayName: "New Member", Password: "new-member-password-long",
	}, 0); err != nil {
		t.Fatalf("start public registration: %v", err)
	}

	sender := &recordingSender{available: true}
	publicURL, err := url.Parse("https://teamtaler.example.test/")
	if err != nil {
		t.Fatalf("parse public URL: %v", err)
	}
	dispatcher, err := NewPublicJoinDispatcher(db, sender, box, publicURL, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("create dispatcher: %v", err)
	}
	dispatcher.now = func() time.Time { return platform.Now().Add(time.Second) }
	processed, err := dispatcher.processOne(ctx)
	if err != nil || !processed {
		t.Fatalf("process public join verification: processed=%v err=%v", processed, err)
	}
	sender.mu.Lock()
	messages := append([]JoinVerificationMessage(nil), sender.joinVerifications...)
	sender.mu.Unlock()
	if len(messages) != 1 || messages[0].ToAddress != "new@example.test" || messages[0].GroupName != "Email Join Group" {
		t.Fatalf("verification messages=%#v", messages)
	}
	verificationURL, err := url.Parse(messages[0].VerifyURL)
	if err != nil || verificationURL.Path != "/join/verify" || verificationURL.Fragment == "" {
		t.Fatalf("verification URL=%q err=%v", messages[0].VerifyURL, err)
	}
	var status string
	var ciphertext sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT status,token_ciphertext FROM public_join_email_outbox`).Scan(&status, &ciphertext); err != nil || status != "SENT" || ciphertext.Valid {
		t.Fatalf("outbox status=%q ciphertext=%#v err=%v", status, ciphertext, err)
	}
}
