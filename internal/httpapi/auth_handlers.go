package httpapi

import (
	"net/http"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/domain"
)

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type sessionResponse struct {
	User          userResponse `json:"user"`
	CSRFToken     string       `json:"csrfToken"`
	Groups        any          `json:"groups"`
	ActiveGroupID *string      `json:"activeGroupId"`
}

type userResponse struct {
	ID          string `json:"id"`
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
}

func (s *Server) handleLogin(response http.ResponseWriter, request *http.Request) {
	var input loginRequest
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	ipKey := s.clientIP(request)
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
	session, err := s.auth.Login(request.Context(), input.Email, input.Password)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	s.loginLimiter.reset(ipKey, identityKey)
	s.setSessionCookies(response, session.Token, session.CSRFToken, int(s.config.SessionLifetime.Seconds()))
	groupItems, err := s.groups.List(request.Context(), session.Principal.UserID)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, newSessionResponse(session.Principal, session.CSRFToken, groupItems))
}

func (s *Server) handleLogout(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if err := s.auth.Logout(request.Context(), principal.SessionHash); err != nil {
		writeProblem(response, request, err)
		return
	}
	s.setSessionCookies(response, "", "", -1)
	response.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleSession(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	groupItems, err := s.groups.List(request.Context(), principal.UserID)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, newSessionResponse(principal, principal.CSRFToken, groupItems))
}

func (s *Server) setSessionCookies(response http.ResponseWriter, token, csrf string, maxAge int) {
	http.SetCookie(response, &http.Cookie{Name: sessionCookieName, Value: token, Path: "/", MaxAge: maxAge, HttpOnly: true, Secure: s.config.SecureCookies, SameSite: http.SameSiteStrictMode})
	http.SetCookie(response, &http.Cookie{Name: csrfCookieName, Value: csrf, Path: "/", MaxAge: maxAge, HttpOnly: false, Secure: s.config.SecureCookies, SameSite: http.SameSiteStrictMode})
}

func (s *Server) handleAcceptInvitation(response http.ResponseWriter, request *http.Request) {
	var input auth.InvitationAcceptance
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	key := s.clientIP(request) + "|invite"
	if !s.loginLimiter.allow(key) {
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
	session, _, err := s.auth.AcceptInvitation(request.Context(), input)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	s.loginLimiter.reset(key)
	s.setSessionCookies(response, session.Token, session.CSRFToken, int(s.config.SessionLifetime.Seconds()))
	groupItems, err := s.groups.List(request.Context(), session.Principal.UserID)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusCreated, newSessionResponse(session.Principal, session.CSRFToken, groupItems))
}

func newSessionResponse(principal domain.Principal, csrf string, groupItems []domain.Group) sessionResponse {
	var activeGroupID *string
	if len(groupItems) > 0 {
		value := groupItems[0].ID
		activeGroupID = &value
	}
	return sessionResponse{User: userResponse{ID: principal.UserID, Email: principal.Email, DisplayName: principal.DisplayName}, CSRFToken: csrf, Groups: groupItems, ActiveGroupID: activeGroupID}
}

func (s *Server) acquirePasswordSlot() bool {
	select {
	case s.passwordSlots <- struct{}{}:
		return true
	default:
		return false
	}
}

func (s *Server) releasePasswordSlot() {
	<-s.passwordSlots
}
