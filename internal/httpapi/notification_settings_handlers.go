package httpapi

import (
	"net/http"

	"github.com/DasLukas/TeamTaler/internal/notifications"
)

// handleResolveNotificationDestination maps an opaque notification ID to its
// active group without exposing cross-account or archived records.
func (s *Server) handleResolveNotificationDestination(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	destination, err := s.notifications.DestinationForUser(request.Context(), principal.UserID, request.PathValue("notificationID"))
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, destination)
}

// handleGetGroupNotificationSettings returns the administration policy and its
// optimistic concurrency ETag for the authenticated group administrator.
func (s *Server) handleGetGroupNotificationSettings(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	settings, err := s.notifications.GetGroupSettings(request.Context(), membership)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(settings.Version))
	writeJSON(response, http.StatusOK, settings)
}

// handleUpdateGroupNotificationSettings atomically replaces a group's event
// policy when If-Match names the current version.
func (s *Server) handleUpdateGroupNotificationSettings(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	expectedVersion, err := requiredIfMatchVersion(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input notifications.GroupSettingsUpdate
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	settings, err := s.notifications.UpdateGroupSettings(request.Context(), principal, membership, input, expectedVersion)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(settings.Version))
	writeJSON(response, http.StatusOK, settings)
}

// handleGetNotificationPreferences returns the current membership's effective
// matrix while retaining disabled group choices outside the editable surface.
func (s *Server) handleGetNotificationPreferences(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	preferences, err := s.notifications.GetPreferences(request.Context(), membership)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(preferences.Version))
	writeJSON(response, http.StatusOK, preferences)
}

// handleUpdateNotificationPreferences applies a partial member channel matrix
// update when If-Match names the current preference version.
func (s *Server) handleUpdateNotificationPreferences(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	expectedVersion, err := requiredIfMatchVersion(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input notifications.PreferencesUpdate
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	preferences, err := s.notifications.UpdatePreferences(request.Context(), membership, input, expectedVersion)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(preferences.Version))
	writeJSON(response, http.StatusOK, preferences)
}
