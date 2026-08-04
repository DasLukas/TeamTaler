package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSPAHandlerServesFilesAndClientRoutes(t *testing.T) {
	root := t.TempDir()
	writeStaticFixture(t, root, "index.html", "spa-shell")
	writeStaticFixture(t, root, "assets/app-deadbeef.js", "console.log('ok')")
	writeStaticFixture(t, root, "robots.txt", "User-agent: *")

	handler := spaHandler(root)
	tests := []struct {
		name        string
		requestPath string
		method      string
		wantStatus  int
		wantBody    string
		wantCache   string
	}{
		{name: "root shell", requestPath: "/", method: http.MethodGet, wantStatus: http.StatusOK, wantBody: "spa-shell", wantCache: "no-cache"},
		{name: "client route fallback", requestPath: "/activities", method: http.MethodGet, wantStatus: http.StatusOK, wantBody: "spa-shell", wantCache: "no-cache"},
		{name: "hashed asset", requestPath: "/assets/app-deadbeef.js", method: http.MethodGet, wantStatus: http.StatusOK, wantBody: "console.log('ok')", wantCache: "public, max-age=31536000, immutable"},
		{name: "concrete public file", requestPath: "/robots.txt", method: http.MethodGet, wantStatus: http.StatusOK, wantBody: "User-agent: *", wantCache: "public, max-age=3600, must-revalidate"},
		{name: "missing asset", requestPath: "/assets/missing.js", method: http.MethodGet, wantStatus: http.StatusNotFound},
		{name: "missing concrete file", requestPath: "/missing.txt", method: http.MethodGet, wantStatus: http.StatusNotFound},
		{name: "unsupported method", requestPath: "/", method: http.MethodPost, wantStatus: http.StatusNotFound},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, "http://teamtaler.test"+test.requestPath, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body = %q", response.Code, test.wantStatus, response.Body.String())
			}
			if test.wantBody != "" && response.Body.String() != test.wantBody {
				t.Fatalf("body = %q, want %q", response.Body.String(), test.wantBody)
			}
			if test.wantCache != "" && response.Header().Get("Cache-Control") != test.wantCache {
				t.Fatalf("Cache-Control = %q, want %q", response.Header().Get("Cache-Control"), test.wantCache)
			}
		})
	}
}

func TestSPAHandlerDoesNotEscapeStaticRoot(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "web")
	writeStaticFixture(t, root, "index.html", "spa-shell")
	if err := os.WriteFile(filepath.Join(parent, "secret.txt"), []byte("outside-secret"), 0o600); err != nil {
		t.Fatalf("write outside fixture: %v", err)
	}

	handler := spaHandler(root)
	for _, requestPath := range []string{"/../secret.txt", "/%2e%2e/secret.txt", "/..\\secret.txt"} {
		t.Run(requestPath, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "http://teamtaler.test"+requestPath, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if strings.Contains(response.Body.String(), "outside-secret") {
				t.Fatalf("request %q exposed a file outside the static root", requestPath)
			}
			if response.Code == http.StatusOK {
				t.Fatalf("request %q unexpectedly returned a successful file response", requestPath)
			}
		})
	}
}

func writeStaticFixture(t *testing.T, root, name, body string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatalf("create fixture directory: %v", err)
	}
	if err := os.WriteFile(path, []byte(body), 0o640); err != nil {
		t.Fatalf("write static fixture: %v", err)
	}
}
