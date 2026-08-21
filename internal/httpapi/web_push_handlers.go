package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/DasLukas/TeamTaler/internal/domain"
	systemadmin "github.com/DasLukas/TeamTaler/internal/system"
	webpushservice "github.com/DasLukas/TeamTaler/internal/webpush"
	push "github.com/marknefedov/go-webpush/v2"
)

func (s *Server) handleListPushSubscriptions(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if s.pushSubscriptions == nil {
		writeJSON(response, http.StatusOK, map[string]any{"items": []webpushservice.Device{}})
		return
	}
	settings, err := s.systemAdmin.GetSettings(request.Context())
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	devices, err := s.pushSubscriptions.List(request.Context(), principal.UserID)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	for index := range devices {
		devices[index].Current = settings.WebPush.KeyID != "" && devices[index].VAPIDKeyID == settings.WebPush.KeyID
	}
	writeJSON(response, http.StatusOK, map[string]any{"items": devices})
}

func (s *Server) handleRegisterPushSubscription(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if s.pushSubscriptions == nil {
		writeProblem(response, request, fmt.Errorf("%w: Web Push subscription storage is unavailable", domain.ErrServiceUnavailable))
		return
	}
	var input struct {
		Label        string                           `json:"label"`
		KeyID        string                           `json:"keyId"`
		Subscription webpushservice.SubscriptionInput `json:"subscription"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	settings, configuration, err := s.systemAdmin.ResolveWebPush(request.Context())
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if !settings.WebPush.Active || !configuration.Enabled {
		writeProblem(response, request, fmt.Errorf("%w: Web Push is not active", domain.ErrServiceUnavailable))
		return
	}
	if input.KeyID != configuration.KeyID {
		writeProblem(response, request, fmt.Errorf("%w: the Web Push key rotated; refresh capabilities and subscribe again", domain.ErrPrecondition))
		return
	}
	device, err := s.pushSubscriptions.Register(request.Context(), principal.UserID, configuration.KeyID, input.Label, input.Subscription)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	device.Current = true
	writeJSON(response, http.StatusCreated, device)
}

func (s *Server) handleRenamePushSubscription(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if s.pushSubscriptions == nil {
		writeProblem(response, request, domain.ErrNotFound)
		return
	}
	var input struct {
		Label string `json:"label"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	device, err := s.pushSubscriptions.Rename(request.Context(), principal.UserID, request.PathValue("subscriptionID"), input.Label)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	settings, err := s.systemAdmin.GetSettings(request.Context())
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	device.Current = settings.WebPush.KeyID != "" && device.VAPIDKeyID == settings.WebPush.KeyID
	writeJSON(response, http.StatusOK, device)
}

func (s *Server) handleDeletePushSubscription(response http.ResponseWriter, request *http.Request) {
	principal, err := s.principal(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if s.pushSubscriptions == nil {
		writeProblem(response, request, domain.ErrNotFound)
		return
	}
	if err := s.pushSubscriptions.Revoke(request.Context(), principal.UserID, request.PathValue("subscriptionID")); err != nil {
		writeProblem(response, request, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleUpdateSystemWebPush(response http.ResponseWriter, request *http.Request) {
	principal, err := s.systemAdministrator(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	expected, err := requiredIfMatchVersion(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		Enabled         *bool   `json:"enabled,omitempty"`
		Subject         *string `json:"subject,omitempty"`
		VAPIDPrivateKey *string `json:"vapidPrivateKey,omitempty"`
		ConfirmRotation bool    `json:"confirmRotation,omitempty"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	if input.Enabled == nil && input.Subject == nil && input.VAPIDPrivateKey == nil {
		writeProblem(response, request, domain.ValidationError{Message: "at least one Web Push setting is required"})
		return
	}
	if input.VAPIDPrivateKey != nil {
		current, currentErr := s.systemAdmin.GetSettings(request.Context())
		if currentErr != nil {
			writeProblem(response, request, currentErr)
			return
		}
		if current.WebPush.VAPIDPrivateKey.Configured && !input.ConfirmRotation {
			writeProblem(response, request, fmt.Errorf("%w: confirmRotation is required to replace the VAPID key", domain.ErrConflict))
			return
		}
	}
	settings, err := s.systemAdmin.UpdateSettings(request.Context(), principal.UserID, expected, systemadmin.SettingsPatch{
		WebPush: &systemadmin.WebPushPatch{Enabled: input.Enabled, Subject: input.Subject, VAPIDPrivateKey: input.VAPIDPrivateKey},
	})
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(settings.Revision))
	writeJSON(response, http.StatusOK, settings)
}

func (s *Server) handleResetSystemWebPush(response http.ResponseWriter, request *http.Request) {
	principal, err := s.systemAdministrator(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	expected, err := requiredIfMatchVersion(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	settings, err := s.systemAdmin.ResetSettings(request.Context(), principal.UserID, expected, []systemadmin.SettingKey{
		systemadmin.SettingWebPushEnabled, systemadmin.SettingWebPushSubject, systemadmin.SettingWebPushVAPIDPrivateKey,
	})
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(settings.Revision))
	writeJSON(response, http.StatusOK, settings)
}

func (s *Server) handleGenerateSystemWebPushKey(response http.ResponseWriter, request *http.Request) {
	principal, err := s.systemAdministrator(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	expected, err := requiredIfMatchVersion(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		ConfirmRotation bool `json:"confirmRotation,omitempty"`
	}
	if request.ContentLength != 0 {
		if err := decodeJSON(response, request, &input); err != nil {
			writeProblem(response, request, err)
			return
		}
	}
	current, err := s.systemAdmin.GetSettings(request.Context())
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if current.Revision != expected {
		writeProblem(response, request, domain.ErrPrecondition)
		return
	}
	if current.WebPush.VAPIDPrivateKey.Configured && !input.ConfirmRotation {
		writeProblem(response, request, fmt.Errorf("%w: confirmRotation is required to rotate the VAPID key", domain.ErrConflict))
		return
	}
	privateKey, _, _, err := webpushservice.GenerateVAPIDKey()
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	settings, err := s.systemAdmin.UpdateSettings(request.Context(), principal.UserID, expected, systemadmin.SettingsPatch{
		WebPush: &systemadmin.WebPushPatch{VAPIDPrivateKey: &privateKey},
	})
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(settings.Revision))
	writeJSON(response, http.StatusOK, settings)
}

func (s *Server) handleTestSystemWebPush(response http.ResponseWriter, request *http.Request) {
	principal, err := s.systemAdministrator(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if s.pushSubscriptions == nil || s.pushSender == nil {
		writeProblem(response, request, fmt.Errorf("%w: Web Push is unavailable", domain.ErrServiceUnavailable))
		return
	}
	limiterKey := s.clientIP(request) + "|web-push-test|" + principal.UserID
	if !s.loginLimiter.allow(limiterKey) {
		response.Header().Set("Retry-After", "900")
		writeProblem(response, request, domain.ErrRateLimited)
		return
	}
	expected, err := requiredIfMatchVersion(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input struct {
		SubscriptionID string `json:"subscriptionId,omitempty"`
	}
	if request.ContentLength != 0 {
		if err := decodeJSON(response, request, &input); err != nil {
			writeProblem(response, request, err)
			return
		}
	}
	settings, configuration, err := s.systemAdmin.ResolveWebPush(request.Context())
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if settings.Revision != expected || !configuration.Enabled {
		writeProblem(response, request, domain.ErrPrecondition)
		return
	}
	subscriptions, err := s.pushSubscriptions.ListActiveForUser(request.Context(), principal.UserID, configuration.KeyID)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var selected *webpushservice.StoredSubscription
	for index := range subscriptions {
		if input.SubscriptionID == "" || subscriptions[index].ID == input.SubscriptionID {
			selected = &subscriptions[index]
			break
		}
	}
	if selected == nil {
		writeProblem(response, request, domain.ErrNotFound)
		return
	}
	payload, _ := json.Marshal(map[string]string{
		"groupName": settings.InstanceName.Value, "eventLabel": "Web Push test notification", "route": "/account",
	})
	if err := s.pushSender.Send(request.Context(), payload, selected.Subscription, configuration.Subject,
		configuration.VAPIDPrivateKey, 5*time.Minute, push.UrgencyNormal); err != nil {
		writeProblem(response, request, fmt.Errorf("%w: Web Push test delivery failed", domain.ErrServiceUnavailable))
		return
	}
	if err := s.pushSubscriptions.MarkUsed(request.Context(), selected.ID); err != nil {
		s.logger.Warn("record Web Push test delivery activity", "error", err)
	}
	writeJSON(response, http.StatusOK, settings)
}
