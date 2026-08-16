package httpapi

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
)

type publicJoinLinkResponse struct {
	Enabled                    bool    `json:"enabled"`
	Expired                    bool    `json:"expired"`
	ExpiresAt                  *string `json:"expiresAt"`
	AcceptURL                  string  `json:"acceptUrl,omitempty"`
	Version                    int64   `json:"version"`
	CreatedAt                  string  `json:"createdAt,omitempty"`
	UpdatedAt                  string  `json:"updatedAt,omitempty"`
	EmailVerificationAvailable bool    `json:"emailVerificationAvailable"`
}

func (s *Server) publicJoinLinkResponse(item groups.PublicJoinLink) publicJoinLinkResponse {
	response := publicJoinLinkResponse{
		Enabled: item.Enabled, Expired: item.Expired, ExpiresAt: item.ExpiresAt, Version: item.Version,
		CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt,
		EmailVerificationAvailable: item.EmailVerificationAvailable,
	}
	if item.Enabled && !item.Expired && item.Token != "" {
		response.AcceptURL = strings.TrimSuffix(s.config.PublicURL.String(), "/") + "/join#token=" + url.QueryEscape(item.Token)
	}
	return response
}

// handleGetPublicJoinLink returns the current administrator-visible join-link
// state and recoverable URL. Tokens remain excluded from logs and response
// metadata. The method writes JSON, ETag, or Problem Details.
func (s *Server) handleGetPublicJoinLink(response http.ResponseWriter, request *http.Request) {
	_, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	item, err := s.groups.GetPublicJoinLink(request.Context(), membership)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if item.Version > 0 {
		response.Header().Set("ETag", versionETag(item.Version))
	}
	writeJSON(response, http.StatusOK, s.publicJoinLinkResponse(item))
}

// handlePutPublicJoinLink creates or replaces link availability and expiry. A
// missing If-Match is accepted only for the initial version-zero resource;
// updates require the current strong ETag.
func (s *Server) handlePutPublicJoinLink(response http.ResponseWriter, request *http.Request) {
	principal, membership, err := s.membership(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		Enabled   bool    `json:"enabled"`
		ExpiresAt *string `json:"expiresAt"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	expectedVersion := int64(0)
	if request.Header.Get("If-Match") != "" {
		expectedVersion, err = requiredIfMatchVersion(request)
		if err != nil {
			writeProblem(response, request, err)
			return
		}
	}
	item, err := s.groups.PutPublicJoinLink(request.Context(), principal, membership, input.Enabled, input.ExpiresAt, expectedVersion)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(item.Version))
	writeJSON(response, http.StatusOK, s.publicJoinLinkResponse(item))
}

// handleRotatePublicJoinLink invalidates the current token and returns a fresh
// URL under a required If-Match precondition.
func (s *Server) handleRotatePublicJoinLink(response http.ResponseWriter, request *http.Request) {
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
	item, err := s.groups.RotatePublicJoinLink(request.Context(), principal, membership, expectedVersion)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(item.Version))
	writeJSON(response, http.StatusOK, s.publicJoinLinkResponse(item))
}

// handlePreviewPublicJoinLink rate-limits a token lookup and returns only safe
// group display metadata.
func (s *Server) handlePreviewPublicJoinLink(response http.ResponseWriter, request *http.Request) {
	if _, err := s.requirePublicJoinRuntime(request, false); err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		Token string `json:"token"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	if !s.loginLimiter.allow(s.clientIP(request) + "|public-join-preview") {
		response.Header().Set("Retry-After", "900")
		writeProblem(response, request, domain.ErrRateLimited)
		return
	}
	preview, err := s.auth.PreviewPublicJoinLink(request.Context(), input.Token)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, preview)
}

// handleStartPublicJoinRegistration queues mandatory mailbox verification and
// always returns the same accepted response for existing and new addresses.
func (s *Server) handleStartPublicJoinRegistration(response http.ResponseWriter, request *http.Request) {
	settingsRevision, err := s.requirePublicJoinRuntime(request, true)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input auth.PublicJoinRegistration
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	ipKey := s.clientIP(request) + "|public-join-register"
	identityKey := ipKey + "|" + strings.ToLower(strings.TrimSpace(input.Email))
	if !s.loginLimiter.allow(ipKey) || !s.loginLimiter.allow(identityKey) {
		response.Header().Set("Retry-After", "900")
		writeProblem(response, request, domain.ErrRateLimited)
		return
	}
	if !s.acquirePasswordSlot() {
		response.Header().Set("Retry-After", "5")
		writeProblem(response, request, domain.ErrRateLimited)
		return
	}
	defer s.releasePasswordSlot()
	if err := s.auth.StartPublicJoinRegistration(request.Context(), input, settingsRevision); err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusAccepted, map[string]bool{"verificationRequired": true})
}

// handleResendPublicJoinVerification rotates a pending verification token. Its
// response shape remains generic when no registration exists.
func (s *Server) handleResendPublicJoinVerification(response http.ResponseWriter, request *http.Request) {
	settingsRevision, err := s.requirePublicJoinRuntime(request, true)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		JoinToken string `json:"joinToken"`
		Email     string `json:"email"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	ipKey := s.clientIP(request) + "|public-join-resend"
	identityKey := ipKey + "|" + strings.ToLower(strings.TrimSpace(input.Email))
	if !s.loginLimiter.allow(ipKey) || !s.loginLimiter.allow(identityKey) {
		response.Header().Set("Retry-After", "900")
		writeProblem(response, request, domain.ErrRateLimited)
		return
	}
	if err := s.auth.ResendPublicJoinVerification(request.Context(), input.JoinToken, input.Email, settingsRevision); err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusAccepted, map[string]bool{"verificationRequired": true})
}

// handleConfirmPublicJoinRegistration consumes one mailbox proof, creates the
// account and membership, sets session cookies, and returns the normal session
// resource.
func (s *Server) handleConfirmPublicJoinRegistration(response http.ResponseWriter, request *http.Request) {
	settingsRevision, err := s.requirePublicJoinRuntime(request, false)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		Token string `json:"token"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	if !s.loginLimiter.allow(s.clientIP(request) + "|public-join-confirm") {
		response.Header().Set("Retry-After", "900")
		writeProblem(response, request, domain.ErrRateLimited)
		return
	}
	session, joinedMembership, err := s.auth.ConfirmPublicJoinRegistration(request.Context(), input.Token, settingsRevision)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	s.setSessionCookies(response, session.Token, session.CSRFToken, int(s.config.SessionLifetime.Seconds()))
	groupItems, err := s.groups.List(request.Context(), session.Principal.UserID)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	sessionPayload, err := s.newSessionResponse(request.Context(), session.Principal, session.CSRFToken, groupItems)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	sessionPayload.ActiveGroupID = &joinedMembership.GroupID
	writeJSON(response, http.StatusCreated, sessionPayload)
}

// handleAcceptPublicJoinLink joins the group using the current authenticated
// account. CSRF middleware protects the mutation.
func (s *Server) handleAcceptPublicJoinLink(response http.ResponseWriter, request *http.Request) {
	settingsRevision, err := s.requirePublicJoinRuntime(request, false)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		Token string `json:"token"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	joinedMembership, err := s.auth.AcceptPublicJoinLink(request.Context(), principal, input.Token, settingsRevision)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	groupsForUser, err := s.groups.List(request.Context(), principal.UserID)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if principal.CSRFToken == "" {
		writeProblem(response, request, fmt.Errorf("%w: missing CSRF session", domain.ErrForbidden))
		return
	}
	sessionPayload, err := s.newSessionResponse(request.Context(), principal, principal.CSRFToken, groupsForUser)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	sessionPayload.ActiveGroupID = &joinedMembership.GroupID
	writeJSON(response, http.StatusOK, sessionPayload)
}

func (s *Server) requirePublicJoinRuntime(request *http.Request, requireEmail bool) (int64, error) {
	settings, loaded := effectiveSystemSettings(request)
	publicJoinEnabled := true
	emailAvailable := s.auth.AccountCapabilities().PasswordResetAvailable
	settingsRevision := int64(0)
	if loaded {
		publicJoinEnabled = settings.PublicJoinEnabled.Value
		emailAvailable = settings.SMTP.Active
		settingsRevision = settings.Revision
	}
	if !publicJoinEnabled {
		return 0, fmt.Errorf("%w: public join is disabled for this instance", domain.ErrServiceUnavailable)
	}
	if requireEmail && !emailAvailable {
		return 0, fmt.Errorf("%w: public registration email delivery is unavailable", domain.ErrServiceUnavailable)
	}
	return settingsRevision, nil
}
