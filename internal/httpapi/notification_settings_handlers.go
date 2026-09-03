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

// handleGetNotificationPreferences returns the current membership's effective
// personal channel matrix.
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
	response.Header().Set("Cache-Control", "private, no-store")
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
