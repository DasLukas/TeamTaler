package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/domain"
)

func TestAccountSecurityHandlersRejectUnknownJSONFields(t *testing.T) {
	server := &Server{
		auth:          auth.Service{},
		loginLimiter:  newLoginLimiter(),
		passwordSlots: make(chan struct{}, 1),
	}
	tests := []struct {
		name          string
		path          string
		body          string
		authenticated bool
		handler       http.HandlerFunc
	}{
		{name: "profile", path: "/api/v1/me/profile", body: `{"displayName":"Ada","unexpected":true}`, authenticated: true, handler: server.handleUpdateProfile},
		{name: "password change", path: "/api/v1/me/password", body: `{"currentPassword":"old password","newPassword":"new secure password","unexpected":true}`, authenticated: true, handler: server.handleChangePassword},
		{name: "password reset request", path: "/api/v1/auth/password-reset/request", body: `{"email":"member@example.test","unexpected":true}`, handler: server.handlePasswordResetRequest},
		{name: "password reset confirmation", path: "/api/v1/auth/password-reset/confirm", body: `{"token":"opaque-token","newPassword":"new secure password","unexpected":true}`, handler: server.handlePasswordResetConfirm},
		{name: "email change", path: "/api/v1/me/email-change", body: `{"newEmail":"new@example.test","currentPassword":"current password","unexpected":true}`, authenticated: true, handler: server.handleStartEmailChange},
		{name: "email change confirmation", path: "/api/v1/auth/email-change/confirm", body: `{"token":"opaque-token","unexpected":true}`, handler: server.handleEmailChangeConfirm},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			if test.authenticated {
				request = request.WithContext(context.WithValue(request.Context(), principalKey, domain.Principal{UserID: "usr_test"}))
			}
			response := httptest.NewRecorder()
			test.handler(response, request)
			if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), "unknown field") {
				t.Fatalf("status=%d body=%q, want unknown-field 422", response.Code, response.Body.String())
			}
		})
	}
}

func TestPublicAccountSecurityEndpointsReturnRateLimited(t *testing.T) {
	server := &Server{
		auth:          auth.Service{},
		loginLimiter:  newLoginLimiter(),
		passwordSlots: make(chan struct{}, 1),
	}
	tests := []struct {
		name      string
		path      string
		body      string
		keySuffix string
		handler   http.HandlerFunc
	}{
		{name: "password reset request", path: "/api/v1/auth/password-reset/request", body: `{"email":"member@example.test"}`, keySuffix: "|password-reset", handler: server.handlePasswordResetRequest},
		{name: "password reset confirmation", path: "/api/v1/auth/password-reset/confirm", body: `{"token":"opaque-token","newPassword":"new secure password"}`, keySuffix: "|password-reset-confirm", handler: server.handlePasswordResetConfirm},
		{name: "email change confirmation", path: "/api/v1/auth/email-change/confirm", body: `{"token":"opaque-token"}`, keySuffix: "|email-change-confirm", handler: server.handleEmailChangeConfirm},
	}
	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			request.RemoteAddr = "192.0.2." + string(rune('1'+index)) + ":12345"
			key := server.clientIP(request) + test.keySuffix
			exhaustLoginLimiter(t, server.loginLimiter, key)

			response := httptest.NewRecorder()
			test.handler(response, request)
			if response.Code != http.StatusTooManyRequests {
				t.Fatalf("status=%d body=%q, want 429", response.Code, response.Body.String())
			}
			if response.Header().Get("Retry-After") == "" {
				t.Fatal("rate-limited response is missing Retry-After")
			}
		})
	}
}

func exhaustLoginLimiter(t *testing.T, limiter *loginLimiter, key string) {
	t.Helper()
	for range 11 {
		if !limiter.allow(key) {
			return
		}
	}
	t.Fatalf("login limiter did not reject key %q", key)
}
