package httpapi

import (
	"database/sql"
	"errors"
	"net/http"
	"os"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/media"
)

// handleProfileAvatar normalizes one multipart image and attaches it to the
// authenticated account. The response contains its protected content-addressed
// URL or Problem Details; request authorization and CSRF checks are supplied by
// middleware.
func (s *Server) handleProfileAvatar(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	imageKey, err := s.storeUploadedImage(response, request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	avatarURL, _, err := s.auth.SetAvatar(request.Context(), principal, imageKey)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"avatarUrl": avatarURL})
}

// handleRemoveProfileAvatar clears the authenticated account's image. The
// response is empty on success or Problem Details on authentication and storage
// failures.
func (s *Server) handleRemoveProfileAvatar(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if _, err := s.auth.RemoveAvatar(request.Context(), principal); err != nil {
		writeProblem(response, request, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

// handleUserAvatar serves a user's current profile image to authenticated users
// who share at least one group with that account. A user may always access their
// own current image. The content-addressed path must match the database record.
func (s *Server) handleUserAvatar(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	targetUserID := request.PathValue("userID")
	imageKey := request.PathValue("imageKey")
	var currentKey sql.NullString
	if targetUserID == principal.UserID {
		err = s.db.QueryRowContext(request.Context(), `SELECT avatar_key FROM users WHERE id=? AND active=1`, targetUserID).Scan(&currentKey)
	} else {
		err = s.db.QueryRowContext(request.Context(), `SELECT target.avatar_key
			FROM users target
			WHERE target.id=? AND target.active=1 AND EXISTS (
				SELECT 1 FROM memberships viewer
				JOIN memberships subject ON subject.group_id=viewer.group_id
				WHERE viewer.user_id=? AND viewer.status='ACTIVE' AND subject.user_id=target.id
				AND (subject.status='ACTIVE' OR EXISTS (
					SELECT 1 FROM membership_roles role
					WHERE role.membership_id=viewer.id AND role.role='ADMIN'
				))
			)`, targetUserID, principal.UserID).Scan(&currentKey)
	}
	if errors.Is(err, sql.ErrNoRows) {
		writeProblem(response, request, domain.ErrNotFound)
		return
	}
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if !currentKey.Valid || currentKey.String != imageKey {
		writeProblem(response, request, domain.ErrNotFound)
		return
	}
	s.serveStoredImage(response, request, imageKey)
}

// serveStoredImage resolves and serves one normalized image from the private
// data directory. Missing or invalid keys intentionally produce a generic 404.
func (s *Server) serveStoredImage(response http.ResponseWriter, request *http.Request, imageKey string) {
	path, err := media.ResolveImage(s.config.DataDirectory, imageKey)
	if err != nil {
		http.NotFound(response, request)
		return
	}
	if _, err := os.Stat(path); err != nil {
		http.NotFound(response, request)
		return
	}
	response.Header().Set("Content-Type", "image/png")
	response.Header().Set("Cache-Control", "private, no-store")
	response.Header().Set("ETag", `"`+strings.TrimSuffix(imageKey, ".png")+`"`)
	http.ServeFile(response, request, path)
}
