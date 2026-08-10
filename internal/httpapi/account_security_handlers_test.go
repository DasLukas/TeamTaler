package httpapi

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestPasswordResetRequestUsesGenericAcceptedResponse(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "password-reset-handler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	box, err := platform.NewSecretBox([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("secret box: %v", err)
	}
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour, TokenSealer: box, EmailDeliveryAvailable: true}
	if err := authService.Bootstrap(ctx, "admin@example.test", "Admin", "correct-horse-battery-staple", "Test Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	server := &Server{auth: authService, loginLimiter: newLoginLimiter()}
	for _, email := range []string{"admin@example.test", "unknown@example.test", "invalid"} {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/password-reset/request", strings.NewReader(`{"email":"`+email+`"}`))
		request.Header.Set("Content-Type", "application/json")
		request.RemoteAddr = "192.0.2.10:12345"
		response := httptest.NewRecorder()
		server.handlePasswordResetRequest(response, request)
		if response.Code != http.StatusAccepted || response.Body.Len() != 0 {
			t.Fatalf("email=%q status=%d body=%q, want empty 202", email, response.Code, response.Body.String())
		}
	}
}

func TestPasswordResetRequestReturnsUnavailableWithoutSMTP(t *testing.T) {
	server := &Server{auth: auth.Service{}, loginLimiter: newLoginLimiter()}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/password-reset/request", strings.NewReader(`{"email":"member@example.test"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.handlePasswordResetRequest(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%q, want 503", response.Code, response.Body.String())
	}
}

func TestEmailChangeStartDoesNotRevealTargetAvailability(t *testing.T) {
	server, principal, db := newEmailChangeHandlerFixture(t)
	ctx := context.Background()
	now := platform.Timestamp(platform.Now())
	if _, err := db.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at)
		VALUES('usr_existing','existing@example.test','Existing Account','credential-hash',?,?)`, now, now); err != nil {
		t.Fatalf("insert existing account: %v", err)
	}

	used := requestEmailChange(server, principal, "existing@example.test")
	available := requestEmailChange(server, principal, "available@example.test")
	for target, response := range map[string]*httptest.ResponseRecorder{"used": used, "available": available} {
		if response.Code != http.StatusAccepted || response.Body.String() != "{\"verificationRequired\":true}\n" {
			t.Fatalf("%s target status=%d body=%q, want identical accepted response", target, response.Code, response.Body.String())
		}
	}
	var actionCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM account_security_actions WHERE user_id=?`, principal.UserID).Scan(&actionCount); err != nil {
		t.Fatalf("count account actions: %v", err)
	}
	if actionCount != 1 {
		t.Fatalf("account actions=%d, want only the available target action", actionCount)
	}
}

func TestEmailChangeStartRateLimitCountsSuccessfulRequests(t *testing.T) {
	server, principal, _ := newEmailChangeHandlerFixture(t)
	for index := range 11 {
		response := requestEmailChange(server, principal, fmt.Sprintf("limited-%d@example.test", index))
		want := http.StatusAccepted
		if index == 10 {
			want = http.StatusTooManyRequests
		}
		if response.Code != want {
			t.Fatalf("request %d status=%d body=%q, want %d", index+1, response.Code, response.Body.String(), want)
		}
	}
}

func newEmailChangeHandlerFixture(t *testing.T) (*Server, domain.Principal, *sql.DB) {
	t.Helper()
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "email-change-handler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	box, err := platform.NewSecretBox([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("secret box: %v", err)
	}
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour, TokenSealer: box, EmailDeliveryAvailable: true}
	if err := authService.Bootstrap(ctx, "admin@example.test", "Admin", "correct-horse-battery-staple", "Test Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	session, err := authService.Login(ctx, "admin@example.test", "correct-horse-battery-staple")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	server := &Server{auth: authService, loginLimiter: newLoginLimiter(), passwordSlots: make(chan struct{}, 2)}
	return server, session.Principal, db
}

func requestEmailChange(server *Server, principal domain.Principal, target string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/me/email-change", strings.NewReader(`{"newEmail":"`+target+`","currentPassword":"correct-horse-battery-staple"}`))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "192.0.2.20:12345"
	request = request.WithContext(context.WithValue(request.Context(), principalKey, principal))
	response := httptest.NewRecorder()
	server.handleStartEmailChange(response, request)
	return response
}

func TestAccountSecurityCSRFExemptionsAreNarrow(t *testing.T) {
	for _, requestPath := range []string{
		"/api/v1/auth/password-reset/request",
		"/api/v1/auth/password-reset/confirm",
		"/api/v1/auth/email-change/confirm",
	} {
		if !isPublicMutation(requestPath) {
			t.Fatalf("%q should be a public mutation", requestPath)
		}
	}
	for _, requestPath := range []string{"/api/v1/me/password", "/api/v1/me/email-change", "/api/v1/me/profile"} {
		if isPublicMutation(requestPath) {
			t.Fatalf("%q must require authenticated CSRF protection", requestPath)
		}
	}
}
