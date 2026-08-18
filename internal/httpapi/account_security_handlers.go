package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
)

func (s *Server) handleAccountCapabilities(response http.ResponseWriter, request *http.Request) {
	settings, loaded := effectiveSystemSettings(request)
	available := s.auth.AccountCapabilities().PasswordResetAvailable
	if loaded {
		available = settings.SMTP.Active
	}
	writeJSON(response, http.StatusOK, auth.AccountCapabilities{PasswordResetAvailable: available, EmailChangeAvailable: available})
}

func (s *Server) handleUpdateProfile(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
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
	updated, err := s.auth.UpdateProfile(request.Context(), principal, input.DisplayName)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, userResponse{ID: updated.UserID, Email: updated.Email, DisplayName: updated.DisplayName, AvatarURL: updated.AvatarURL})
}

func (s *Server) handleChangePassword(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	ipKey := s.clientIP(request) + "|password-change"
	userKey := ipKey + "|" + principal.UserID
	if !s.loginLimiter.allow(ipKey) || !s.loginLimiter.allow(userKey) {
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
	if err := s.auth.ChangePassword(request.Context(), principal, input.CurrentPassword, input.NewPassword); err != nil {
		writeProblem(response, request, err)
		return
	}
	s.loginLimiter.reset(ipKey, userKey)
	s.setSessionCookies(response, "", "", -1)
	response.WriteHeader(http.StatusNoContent)
}

func (s *Server) handlePasswordResetRequest(response http.ResponseWriter, request *http.Request) {
	var input struct {
		Email string `json:"email"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	ipKey := s.clientIP(request) + "|password-reset"
	identityKey := ipKey + "|" + platform.HashSecret(strings.ToLower(strings.TrimSpace(input.Email)))
	if !s.loginLimiter.allow(ipKey) || !s.loginLimiter.allow(identityKey) {
		response.Header().Set("Retry-After", "900")
		writeProblem(response, request, domain.ErrRateLimited)
		return
	}
	if err := s.requireRuntimeEmail(request); err != nil {
		writeProblem(response, request, err)
		return
	}
	if err := s.auth.StartPasswordReset(request.Context(), input.Email); err != nil {
		writeProblem(response, request, err)
		return
	}
	response.WriteHeader(http.StatusAccepted)
}

func (s *Server) handlePasswordResetConfirm(response http.ResponseWriter, request *http.Request) {
	var input struct {
		Token       string `json:"token"`
		NewPassword string `json:"newPassword"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	ipKey := s.clientIP(request) + "|password-reset-confirm"
	tokenKey := ipKey + "|" + platform.HashSecret(strings.TrimSpace(input.Token))
	if !s.loginLimiter.allow(ipKey) || !s.loginLimiter.allow(tokenKey) {
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
	if err := s.auth.ConfirmPasswordReset(request.Context(), input.Token, input.NewPassword); err != nil {
		writeProblem(response, request, err)
		return
	}
	s.loginLimiter.reset(ipKey, tokenKey)
	s.setSessionCookies(response, "", "", -1)
	response.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleStartEmailChange(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		NewEmail        string `json:"newEmail"`
		CurrentPassword string `json:"currentPassword"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	key := s.clientIP(request) + "|email-change|" + principal.UserID
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
	if err := s.requireRuntimeEmail(request); err != nil {
		writeProblem(response, request, err)
		return
	}
	if err := s.auth.StartEmailChange(request.Context(), principal, input.NewEmail, input.CurrentPassword); err != nil {
		if errors.Is(err, domain.ErrConflict) {
			writeJSON(response, http.StatusAccepted, map[string]bool{"verificationRequired": true})
			return
		}
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusAccepted, map[string]bool{"verificationRequired": true})
}

func (s *Server) requireRuntimeEmail(request *http.Request) error {
	settings, loaded := effectiveSystemSettings(request)
	available := s.auth.AccountCapabilities().PasswordResetAvailable
	if loaded {
		available = settings.SMTP.Active
	}
	if !available {
		return fmt.Errorf("%w: email delivery is unavailable", domain.ErrServiceUnavailable)
	}
	return nil
}

func (s *Server) handleEmailChangeConfirm(response http.ResponseWriter, request *http.Request) {
	var input struct {
		Token string `json:"token"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	ipKey := s.clientIP(request) + "|email-change-confirm"
	tokenKey := ipKey + "|" + platform.HashSecret(strings.TrimSpace(input.Token))
	if !s.loginLimiter.allow(ipKey) || !s.loginLimiter.allow(tokenKey) {
		response.Header().Set("Retry-After", "900")
		writeProblem(response, request, domain.ErrRateLimited)
		return
	}
	if err := s.auth.ConfirmEmailChange(request.Context(), input.Token); err != nil {
		writeProblem(response, request, err)
		return
	}
	s.loginLimiter.reset(ipKey, tokenKey)
	s.setSessionCookies(response, "", "", -1)
	response.WriteHeader(http.StatusNoContent)
}
