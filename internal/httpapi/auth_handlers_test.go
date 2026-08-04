package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPasswordHashCapacityUsesProblemDetails(t *testing.T) {
	tests := []struct {
		name   string
		path   string
		body   string
		handle func(*Server, http.ResponseWriter, *http.Request)
	}{
		{
			name: "login",
			path: "/api/v1/auth/login",
			body: `{"email":"member@example.test","password":"password-long-enough"}`,
			handle: func(server *Server, response http.ResponseWriter, request *http.Request) {
				server.handleLogin(response, request)
			},
		},
		{
			name: "invitation acceptance",
			path: "/api/v1/invitations/accept",
			body: `{"token":"one-time-token","displayName":"Member","password":"password-long-enough"}`,
			handle: func(server *Server, response http.ResponseWriter, request *http.Request) {
				server.handleAcceptInvitation(response, request)
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := &Server{loginLimiter: newLoginLimiter(), passwordSlots: make(chan struct{}, 1)}
			server.passwordSlots <- struct{}{}
			request := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			request.RemoteAddr = "192.0.2.10:12345"
			response := httptest.NewRecorder()

			test.handle(server, response, request)

			if response.Code != http.StatusTooManyRequests {
				t.Fatalf("status = %d, want %d", response.Code, http.StatusTooManyRequests)
			}
			if response.Header().Get("Content-Type") != "application/problem+json; charset=utf-8" {
				t.Fatalf("Content-Type = %q", response.Header().Get("Content-Type"))
			}
			if response.Header().Get("Retry-After") != "5" {
				t.Fatalf("Retry-After = %q, want 5", response.Header().Get("Retry-After"))
			}
			var body problem
			if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
				t.Fatalf("decode problem details: %v", err)
			}
			if body.Status != http.StatusTooManyRequests || body.Type != "https://teamtaler.dev/problems/rate-limited" || body.Instance != test.path {
				t.Fatalf("unexpected problem details: %#v", body)
			}
		})
	}
}
