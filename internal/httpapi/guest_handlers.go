package httpapi

import (
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
)

// handleUpdateGuestSettings applies the complete guest-feature configuration
// atomically, including optional role creation and default-role replacement.
func (s *Server) handleUpdateGuestSettings(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		GuestsEnabled            *bool   `json:"guestsEnabled"`
		GuestRoleID              *string `json:"guestRoleId"`
		CreateGuestRole          bool    `json:"createGuestRole"`
		ReplacementDefaultRoleID *string `json:"replacementDefaultRoleId"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	if input.GuestsEnabled == nil {
		writeProblem(response, request, domain.ValidationError{Field: "guestsEnabled", Message: "is required"})
		return
	}
	settings, err := s.groups.UpdateGuestSettings(request.Context(), principal, membership, groups.GuestSettingsUpdate{
		GuestsEnabled:            *input.GuestsEnabled,
		GuestRoleID:              input.GuestRoleID,
		CreateGuestRole:          input.CreateGuestRole,
		ReplacementDefaultRoleID: input.ReplacementDefaultRoleID,
	})
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"notificationEmailsEnabled":          settings.NotificationEmailsEnabled,
		"notificationEmailDeliveryAvailable": s.config.SMTP.Enabled,
		"defaultRoleId":                      settings.DefaultRoleID,
		"guestsEnabled":                      settings.GuestsEnabled,
		"guestRoleId":                        settings.GuestRoleID,
	})
}

// handleRenameManagedGuest renames an active credential-less guest while
// preserving membership and financial identifiers.
func (s *Server) handleRenameManagedGuest(response http.ResponseWriter, request *http.Request) {
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
	item, err := s.groups.RenameManagedGuest(request.Context(), principal, membership, request.PathValue("membershipID"), input.DisplayName)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, item)
}

// handleCreateGuestClaimInvitation starts an in-place login promotion for one
// active managed guest and returns the normal secret-free invitation envelope.
func (s *Server) handleCreateGuestClaimInvitation(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		Email string `json:"email"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.groups.CreateClaimInvitation(request.Context(), principal, membership, request.PathValue("membershipID"), input.Email)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	acceptURL := strings.TrimSuffix(s.config.PublicURL.String(), "/") + "/invite#token=" + url.QueryEscape(item.Token)
	item.Token = ""
	writeJSON(response, http.StatusCreated, map[string]any{"invitation": item, "acceptUrl": acceptURL})
}

func managedGuestConflictMembershipID(err error) (string, bool) {
	var conflict groups.ManagedGuestNameConflictError
	if !errors.As(err, &conflict) {
		return "", false
	}
	return conflict.MembershipID, conflict.MembershipID != ""
}
