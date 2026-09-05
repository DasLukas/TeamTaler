package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBuildInformationUsesSharedNormalizedIdentifier(t *testing.T) {
	t.Parallel()

	information := NewBuildInformation(" 1.2.0 ", " abc123 ")
	if information.BuildID != "1.2.0@abc123" {
		t.Fatalf("build ID = %q, want %q", information.BuildID, "1.2.0@abc123")
	}
	if fallback := NewBuildInformation("", ""); fallback.BuildID != "dev@unknown" {
		t.Fatalf("fallback build ID = %q, want %q", fallback.BuildID, "dev@unknown")
	}
}

func TestHandleBuildInformationReturnsPublicBuildID(t *testing.T) {
	t.Parallel()

	server := &Server{buildInformation: NewBuildInformation("1.2.0", "abc123")}
	request := httptest.NewRequest(http.MethodGet, "http://teamtaler.test/api/v1/instance/build", nil)
	response := httptest.NewRecorder()

	server.handleBuildInformation(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
	}
	var information BuildInformation
	if err := json.Unmarshal(response.Body.Bytes(), &information); err != nil {
		t.Fatalf("decode build information: %v", err)
	}
	if information.BuildID != "1.2.0@abc123" {
		t.Fatalf("build ID = %q, want %q", information.BuildID, "1.2.0@abc123")
	}
}
