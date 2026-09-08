package httpapi

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRequestContextLogsResponseStatus(t *testing.T) {
	tests := []struct {
		name       string
		handler    http.Handler
		wantStatus int
	}{
		{
			name:       "implicit success",
			handler:    http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}),
			wantStatus: http.StatusOK,
		},
		{
			name: "explicit failure",
			handler: http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.WriteHeader(http.StatusUnauthorized)
			}),
			wantStatus: http.StatusUnauthorized,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var output bytes.Buffer
			server := &Server{logger: slog.New(slog.NewJSONHandler(&output, nil))}
			request := httptest.NewRequest(http.MethodGet, "http://teamtaler.test/health/live", nil)
			response := httptest.NewRecorder()

			server.requestContext(test.handler).ServeHTTP(response, request)

			var entry map[string]any
			if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &entry); err != nil {
				t.Fatalf("decode request log: %v", err)
			}
			if entry["status"] != float64(test.wantStatus) {
				t.Fatalf("status=%v, want %d", entry["status"], test.wantStatus)
			}
			if response.Header().Get("X-Request-ID") == "" {
				t.Fatal("response is missing X-Request-ID")
			}
		})
	}
}
