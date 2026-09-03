package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/notifications"
)

func TestNotificationPreferenceHandlersEnforceETagsAndExposePersonalContract(t *testing.T) {
	server, principal, administrator := invitationImportServer(t, false)
	server.notifications = notifications.Service{DB: server.db, EmailDeliveryAvailable: true}

	getPreferences := roleHandlerRequest(principal, administrator.GroupID, http.MethodGet, "")
	preferencesResponse := httptest.NewRecorder()
	server.handleGetNotificationPreferences(preferencesResponse, getPreferences)
	if preferencesResponse.Code != http.StatusOK || preferencesResponse.Header().Get("ETag") != `"v1"` || preferencesResponse.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("get notification preferences status=%d ETag=%q cache=%q body=%s", preferencesResponse.Code, preferencesResponse.Header().Get("ETag"), preferencesResponse.Header().Get("Cache-Control"), preferencesResponse.Body.String())
	}
	var preferences notifications.Preferences
	if err := json.Unmarshal(preferencesResponse.Body.Bytes(), &preferences); err != nil || len(preferences.Events) != 4 || len(preferences.AvailableChannels) != 1 {
		t.Fatalf("notification preferences=%#v err=%v", preferences, err)
	}

	email := true
	preferenceBody, err := json.Marshal(notifications.PreferencesUpdate{Events: []notifications.PreferenceUpdate{{Type: notifications.TypeBookingAssigned, Email: &email}}})
	if err != nil {
		t.Fatalf("encode notification preferences update: %v", err)
	}
	updatePreferences := roleHandlerRequest(principal, administrator.GroupID, http.MethodPut, string(preferenceBody))
	updatePreferences.Header.Set("If-Match", preferencesResponse.Header().Get("ETag"))
	updatedPreferencesResponse := httptest.NewRecorder()
	server.handleUpdateNotificationPreferences(updatedPreferencesResponse, updatePreferences)
	if updatedPreferencesResponse.Code != http.StatusOK || updatedPreferencesResponse.Header().Get("ETag") != `"v2"` {
		t.Fatalf("update notification preferences status=%d ETag=%q body=%s", updatedPreferencesResponse.Code, updatedPreferencesResponse.Header().Get("ETag"), updatedPreferencesResponse.Body.String())
	}

	stalePreferences := roleHandlerRequest(principal, administrator.GroupID, http.MethodPut, string(preferenceBody))
	stalePreferences.Header.Set("If-Match", `"v1"`)
	stalePreferencesResponse := httptest.NewRecorder()
	server.handleUpdateNotificationPreferences(stalePreferencesResponse, stalePreferences)
	if stalePreferencesResponse.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale notification preferences status=%d body=%s", stalePreferencesResponse.Code, stalePreferencesResponse.Body.String())
	}
}
