package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/notifications"
)

func TestNotificationSettingsHandlersEnforceETagsAndExposeCanonicalContract(t *testing.T) {
	server, principal, administrator := invitationImportServer(t, false)
	server.notifications = notifications.Service{DB: server.db, EmailDeliveryAvailable: true}

	getSettings := roleHandlerRequest(principal, administrator.GroupID, http.MethodGet, "")
	settingsResponse := httptest.NewRecorder()
	server.handleGetGroupNotificationSettings(settingsResponse, getSettings)
	if settingsResponse.Code != http.StatusOK || settingsResponse.Header().Get("ETag") != `"v1"` {
		t.Fatalf("get notification settings status=%d ETag=%q body=%s", settingsResponse.Code, settingsResponse.Header().Get("ETag"), settingsResponse.Body.String())
	}
	var settings notifications.GroupSettings
	if err := json.Unmarshal(settingsResponse.Body.Bytes(), &settings); err != nil || len(settings.Events) != 14 || settings.Timezone != "Europe/Berlin" {
		t.Fatalf("notification settings=%#v err=%v", settings, err)
	}
	updates := make([]notifications.GroupEventUpdate, 0, len(settings.Events))
	for _, event := range settings.Events {
		updates = append(updates, notifications.GroupEventUpdate{Type: event.Type, Enabled: true})
	}
	body, err := json.Marshal(notifications.GroupSettingsUpdate{
		Timezone: "Europe/Berlin", DueSoonLeadDays: 4, OverdueRepeatDays: 7, Events: updates,
	})
	if err != nil {
		t.Fatalf("encode notification settings update: %v", err)
	}
	missingETag := roleHandlerRequest(principal, administrator.GroupID, http.MethodPut, string(body))
	missingETagResponse := httptest.NewRecorder()
	server.handleUpdateGroupNotificationSettings(missingETagResponse, missingETag)
	if missingETagResponse.Code != http.StatusPreconditionFailed {
		t.Fatalf("missing notification settings ETag status=%d body=%s", missingETagResponse.Code, missingETagResponse.Body.String())
	}
	updateSettings := roleHandlerRequest(principal, administrator.GroupID, http.MethodPut, string(body))
	updateSettings.Header.Set("If-Match", settingsResponse.Header().Get("ETag"))
	updatedSettingsResponse := httptest.NewRecorder()
	server.handleUpdateGroupNotificationSettings(updatedSettingsResponse, updateSettings)
	if updatedSettingsResponse.Code != http.StatusOK || updatedSettingsResponse.Header().Get("ETag") != `"v2"` {
		t.Fatalf("update notification settings status=%d ETag=%q body=%s", updatedSettingsResponse.Code, updatedSettingsResponse.Header().Get("ETag"), updatedSettingsResponse.Body.String())
	}

	getPreferences := roleHandlerRequest(principal, administrator.GroupID, http.MethodGet, "")
	preferencesResponse := httptest.NewRecorder()
	server.handleGetNotificationPreferences(preferencesResponse, getPreferences)
	if preferencesResponse.Code != http.StatusOK || preferencesResponse.Header().Get("ETag") != `"v1"` || preferencesResponse.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("get notification preferences status=%d ETag=%q cache=%q body=%s", preferencesResponse.Code, preferencesResponse.Header().Get("ETag"), preferencesResponse.Header().Get("Cache-Control"), preferencesResponse.Body.String())
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
