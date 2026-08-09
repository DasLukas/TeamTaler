package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
)

func TestGroupSettingsExposeOnlyNotificationDelivery(t *testing.T) {
	t.Parallel()
	server, principal, administrator := invitationImportServer(t, false)

	get := roleHandlerRequest(principal, administrator.GroupID, http.MethodGet, "")
	response := httptest.NewRecorder()
	server.handleGetGroupSettings(response, get)
	if response.Code != http.StatusOK {
		t.Fatalf("get settings status = %d, body = %s", response.Code, response.Body.String())
	}
	var settings domain.GroupSettings
	if err := json.Unmarshal(response.Body.Bytes(), &settings); err != nil {
		t.Fatalf("decode settings: %v", err)
	}
	if settings.NotificationEmailsEnabled {
		t.Fatalf("default settings = %#v", settings)
	}

	update := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, `{"notificationEmailsEnabled":false}`)
	updatedResponse := httptest.NewRecorder()
	server.handleUpdateGroupSettings(updatedResponse, update)
	if updatedResponse.Code != http.StatusOK {
		t.Fatalf("settings update status = %d, body = %s", updatedResponse.Code, updatedResponse.Body.String())
	}

	unsupported := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, `{"membersCanViewAllBookings":true}`)
	unsupportedResponse := httptest.NewRecorder()
	server.handleUpdateGroupSettings(unsupportedResponse, unsupported)
	if unsupportedResponse.Code != http.StatusUnprocessableEntity {
		t.Fatalf("deprecated setting status = %d, body = %s", unsupportedResponse.Code, unsupportedResponse.Body.String())
	}
}

func TestGuestSettingsRequireGuestsEnabled(t *testing.T) {
	t.Parallel()
	server, principal, administrator := invitationImportServer(t, false)

	for _, body := range []string{`{}`, `{"guestsEnabled":null}`} {
		request := roleHandlerRequest(principal, administrator.GroupID, http.MethodPut, body)
		response := httptest.NewRecorder()
		server.handleUpdateGuestSettings(response, request)
		if response.Code != http.StatusUnprocessableEntity {
			t.Fatalf("guest settings body %s status = %d, response = %s", body, response.Code, response.Body.String())
		}
	}
}
