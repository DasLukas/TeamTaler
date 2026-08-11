package httpapi

import (
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/groups"
)

// handleRenameTemporaryGuest renames an active credential-less guest while
// preserving membership and financial identifiers.
func (s *Server) handleRenameTemporaryGuest(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		DisplayName string `json:"displayName"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.groups.RenameTemporaryGuest(request.Context(), principal, membership, request.PathValue("membershipID"), input.DisplayName)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, item)
}

// handleCreateTemporaryGuestClaimInvitation starts an in-place login promotion
// for one temporary guest and returns the normal secret-free invitation envelope.
func (s *Server) handleCreateTemporaryGuestClaimInvitation(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		Email   string   `json:"email"`
		RoleIDs []string `json:"roleIds"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.groups.CreateTemporaryGuestClaimInvitation(request.Context(), principal, membership, request.PathValue("membershipID"), input.Email, input.RoleIDs)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	acceptURL := strings.TrimSuffix(s.config.PublicURL.String(), "/") + "/invite#token=" + url.QueryEscape(item.Token)
	item.Token = ""
	writeJSON(response, http.StatusCreated, map[string]any{"invitation": item, "acceptUrl": acceptURL})
}

func temporaryGuestConflictMembershipID(err error) (string, bool) {
	var conflict groups.TemporaryGuestNameConflictError
	if !errors.As(err, &conflict) {
		return "", false
	}
	return conflict.MembershipID, conflict.MembershipID != ""
}
