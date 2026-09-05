package httpapi

import (
	"net/http"
)

// handleBuildInformation returns the immutable identifier shared by the
// running server and the web assets bundled into the same application image.
func (s *Server) handleBuildInformation(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, s.buildInformation)
}

func (s *Server) handleLive(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleReady(response http.ResponseWriter, request *http.Request) {
	if err := s.db.PingContext(request.Context()); err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Server) handleListNotifications(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	page, err := s.notifications.ListPage(request.Context(), membership, queryLimit(request), request.URL.Query().Get("cursor"))
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if page.NextCursor != "" {
		response.Header().Set("X-Next-Cursor", page.NextCursor)
	}
	writeJSON(response, http.StatusOK, page.Items)
}

// handleNotificationSummary returns the exact unread count for the current
// membership without loading account or notification content.
func (s *Server) handleNotificationSummary(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	count, err := s.notifications.UnreadCount(request.Context(), membership)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]int64{"unreadCount": count})
}

// handleMarkNotificationsRead acknowledges a bounded set of visible
// notifications and returns the remaining unread count.
func (s *Server) handleMarkNotificationsRead(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		NotificationIDs []string `json:"notificationIds"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	result, err := s.notifications.MarkReadMany(request.Context(), membership, input.NotificationIDs)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func (s *Server) handleUpdateNotification(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		Read bool `json:"read"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.notifications.MarkRead(request.Context(), membership, request.PathValue("notificationID"), input.Read)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, item)
}
