package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/config"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/email"
	systemadmin "github.com/DasLukas/TeamTaler/internal/system"
)

type instanceCapabilitiesResponse struct {
	InstanceName                string `json:"instanceName"`
	MaintenanceMode             bool   `json:"maintenanceMode"`
	MaintenanceMessage          string `json:"maintenanceMessage,omitempty"`
	PublicJoinEnabled           bool   `json:"publicJoinEnabled"`
	MediaUploadMaxBytes         int64  `json:"mediaUploadMaxBytes"`
	EmailNotificationsAvailable bool   `json:"emailNotificationsAvailable"`
	WebPushAvailable            bool   `json:"webPushAvailable"`
	WebPushPublicKey            string `json:"webPushPublicKey,omitempty"`
	WebPushKeyID                string `json:"webPushKeyId,omitempty"`
}

type systemGroupInvitationResponse struct {
	Group               systemadmin.ManagedGroup `json:"group"`
	AcceptURL           string                   `json:"acceptUrl,omitempty"`
	EmailDeliveryStatus string                   `json:"emailDeliveryStatus,omitempty"`
	ExpiresAt           string                   `json:"expiresAt,omitempty"`
}

func (s *Server) systemGroupInvitationResponse(item systemadmin.ManagedGroup) systemGroupInvitationResponse {
	result := systemGroupInvitationResponse{Group: item}
	if item.InvitationToken == "" {
		return result
	}
	result.AcceptURL = strings.TrimSuffix(s.config.PublicURL.String(), "/") + "/invite#token=" + url.QueryEscape(item.InvitationToken)
	result.EmailDeliveryStatus = string(item.InvitationEmailDeliveryStatus)
	result.ExpiresAt = item.InvitationExpiresAt
	return result
}

func (s *Server) handleInstanceCapabilities(response http.ResponseWriter, request *http.Request) {
	settings, err := s.systemAdmin.GetSettings(request.Context())
	if err != nil {
		writeProblem(response, request, domain.ErrServiceUnavailable)
		return
	}
	writeJSON(response, http.StatusOK, instanceCapabilitiesResponse{
		InstanceName: settings.InstanceName.Value, MaintenanceMode: settings.MaintenanceMode.Value,
		MaintenanceMessage: settings.MaintenanceMessage.Value, PublicJoinEnabled: settings.PublicJoinEnabled.Value,
		MediaUploadMaxBytes: settings.MediaUploadMaxBytes.Value, EmailNotificationsAvailable: settings.SMTP.Active,
		WebPushAvailable: settings.WebPush.Active, WebPushPublicKey: settings.WebPush.PublicKey,
		WebPushKeyID: settings.WebPush.KeyID,
	})
}

func (s *Server) systemAdministrator(request *http.Request) (domain.Principal, error) {
	principal, err := s.principal(request)
	if err != nil {
		return domain.Principal{}, err
	}
	if err := s.systemAdmin.RequireAdministrator(request.Context(), principal.UserID); err != nil {
		return domain.Principal{}, err
	}
	return principal, nil
}

func (s *Server) handleSystemSettings(response http.ResponseWriter, request *http.Request) {
	if _, err := s.systemAdministrator(request); err != nil {
		writeProblem(response, request, err)
		return
	}
	settings, err := s.systemAdmin.GetSettings(request.Context())
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(settings.Revision))
	writeJSON(response, http.StatusOK, settings)
}

func (s *Server) handleUpdateSystemSettings(response http.ResponseWriter, request *http.Request) {
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
		InstanceName        *string `json:"instanceName,omitempty"`
		DefaultCurrency     *string `json:"defaultCurrency,omitempty"`
		MediaUploadMaxBytes *int64  `json:"mediaUploadMaxBytes,omitempty"`
		PublicJoinEnabled   *bool   `json:"publicJoinEnabled,omitempty"`
		MaintenanceMode     *bool   `json:"maintenanceMode,omitempty"`
		MaintenanceMessage  *string `json:"maintenanceMessage,omitempty"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	patch := systemadmin.SettingsPatch{
		InstanceName: input.InstanceName, DefaultCurrency: input.DefaultCurrency,
		MediaUploadMaxBytes: input.MediaUploadMaxBytes, PublicJoinEnabled: input.PublicJoinEnabled,
		MaintenanceMode: input.MaintenanceMode, MaintenanceMessage: input.MaintenanceMessage,
	}
	if patch.InstanceName == nil && patch.DefaultCurrency == nil && patch.MediaUploadMaxBytes == nil &&
		patch.PublicJoinEnabled == nil && patch.MaintenanceMode == nil && patch.MaintenanceMessage == nil {
		writeProblem(response, request, domain.ValidationError{Message: "at least one system setting is required"})
		return
	}
	settings, err := s.systemAdmin.UpdateSettings(request.Context(), principal.UserID, expected, patch)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(settings.Revision))
	writeJSON(response, http.StatusOK, settings)
}

func (s *Server) handleResetSystemSettings(response http.ResponseWriter, request *http.Request) {
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
		Keys []systemadmin.SettingKey `json:"keys"`
	}
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	if len(input.Keys) == 0 {
		writeProblem(response, request, domain.ValidationError{Field: "keys", Message: "must contain at least one setting key"})
		return
	}
	settings, err := s.systemAdmin.ResetSettings(request.Context(), principal.UserID, expected, input.Keys)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(settings.Revision))
	writeJSON(response, http.StatusOK, settings)
}

func (s *Server) handleUpdateSystemSMTP(response http.ResponseWriter, request *http.Request) {
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
	var smtpPatch systemadmin.SMTPPatch
	if err := decodeJSON(response, request, &smtpPatch); err != nil {
		writeProblem(response, request, err)
		return
	}
	if smtpPatch.Enabled == nil && smtpPatch.Host == nil && smtpPatch.Port == nil && smtpPatch.TLSMode == nil &&
		smtpPatch.Username == nil && smtpPatch.Password == nil && smtpPatch.FromAddress == nil && smtpPatch.FromName == nil {
		writeProblem(response, request, domain.ValidationError{Message: "at least one SMTP setting is required"})
		return
	}
	settings, err := s.systemAdmin.UpdateSettings(request.Context(), principal.UserID, expected, systemadmin.SettingsPatch{SMTP: &smtpPatch})
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(settings.Revision))
	writeJSON(response, http.StatusOK, settings)
}

func (s *Server) handleResetSystemSMTP(response http.ResponseWriter, request *http.Request) {
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
	keys := []systemadmin.SettingKey{
		systemadmin.SettingSMTPEnabled, systemadmin.SettingSMTPHost, systemadmin.SettingSMTPPort,
		systemadmin.SettingSMTPTLSMode, systemadmin.SettingSMTPUsername, systemadmin.SettingSMTPPassword,
		systemadmin.SettingSMTPFromAddress, systemadmin.SettingSMTPFromName,
	}
	settings, err := s.systemAdmin.ResetSettings(request.Context(), principal.UserID, expected, keys)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(settings.Revision))
	writeJSON(response, http.StatusOK, settings)
}

func (s *Server) handleTestSystemSMTP(response http.ResponseWriter, request *http.Request) {
	principal, err := s.systemAdministrator(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	key := s.clientIP(request) + "|smtp-test|" + principal.UserID
	if !s.loginLimiter.allow(key) {
		response.Header().Set("Retry-After", "900")
		writeProblem(response, request, domain.ErrRateLimited)
		return
	}
	expected, err := requiredIfMatchVersion(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	settings, configuration, err := s.systemAdmin.ResolveRuntime(request.Context())
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	if settings.Revision != expected || !settings.SMTP.ConfigurationValid ||
		(settings.SMTP.RequiresTest && settings.SMTP.Revision < 1) {
		writeProblem(response, request, domain.ErrPrecondition)
		return
	}
	configuration.Enabled = true
	testRecipient := principal.Email
	testRecipientName := principal.DisplayName
	if s.config.SMTPTestRecipient != "" {
		testRecipient = s.config.SMTPTestRecipient
		testRecipientName = ""
	}
	sender, err := email.NewSMTP(toSMTPConfig(configuration))
	if err == nil {
		err = sender.SendNotification(request.Context(), email.NotificationMessage{
			ToAddress: testRecipient, ToName: testRecipientName,
			GroupName: settings.InstanceName.Value, Title: "SMTP configuration test",
			Body:      "This message confirms that the current TeamTaler SMTP configuration can deliver email.",
			ActionURL: strings.TrimSuffix(s.config.PublicURL.String(), "/") + "/admin",
		})
	}
	if err != nil {
		if settings.SMTP.RequiresTest {
			if _, stateErr := s.systemAdmin.MarkSMTPTestFailed(request.Context(), principal.UserID, expected, settings.SMTP.Revision); stateErr != nil {
				s.logger.Error("record failed SMTP configuration test", "error", stateErr)
			}
		}
		writeProblem(response, request, fmt.Errorf("%w: SMTP test delivery failed", domain.ErrServiceUnavailable))
		return
	}
	if settings.SMTP.RequiresTest {
		settings, err = s.systemAdmin.MarkSMTPTested(request.Context(), principal.UserID, expected, settings.SMTP.Revision)
		if err != nil {
			writeProblem(response, request, err)
			return
		}
	}
	response.Header().Set("ETag", versionETag(settings.Revision))
	writeJSON(response, http.StatusOK, settings)
}

func toSMTPConfig(value systemadmin.SMTPConfiguration) config.SMTPConfig {
	return config.SMTPConfig{
		Enabled: value.Enabled, Host: value.Host, Port: value.Port,
		Username: value.Username, Password: value.Password, FromAddress: value.FromAddress,
		FromName: value.FromName, TLSMode: config.SMTPTLSMode(value.TLSMode),
		AllowPrivateNetwork: value.AllowPrivateNetwork, AllowedPrivateHost: value.AllowedPrivateHost,
		AllowedPrivatePort: value.AllowedPrivatePort,
	}
}

func (s *Server) handleListSystemAdministrators(response http.ResponseWriter, request *http.Request) {
	if _, err := s.systemAdministrator(request); err != nil {
		writeProblem(response, request, err)
		return
	}
	items, err := s.systemAdmin.ListAdministrators(request.Context())
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleSearchSystemAccounts(response http.ResponseWriter, request *http.Request) {
	principal, err := s.systemAdministrator(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	items, err := s.systemAdmin.SearchAccounts(request.Context(), principal.UserID, request.URL.Query().Get("q"), queryLimit(request))
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleListSystemGroups(response http.ResponseWriter, request *http.Request) {
	principal, err := s.systemAdministrator(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	items, err := s.systemAdmin.ListGroups(request.Context(), principal.UserID)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"items": items})
}

// handleSystemGroupLogo serves the current logo of one managed group to a
// live system administrator without granting access to other group resources.
func (s *Server) handleSystemGroupLogo(response http.ResponseWriter, request *http.Request) {
	if _, err := s.systemAdministrator(request); err != nil {
		writeProblem(response, request, err)
		return
	}
	var imageKey string
	if err := s.db.QueryRowContext(request.Context(), `SELECT logo_key FROM groups WHERE id=? AND logo_key IS NOT NULL`, request.PathValue("groupID")).Scan(&imageKey); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeProblem(response, request, domain.ErrNotFound)
			return
		}
		writeProblem(response, request, err)
		return
	}
	s.serveStoredImage(response, request, imageKey)
}

func (s *Server) handleCreateSystemGroup(response http.ResponseWriter, request *http.Request) {
	principal, err := s.systemAdministrator(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	var input systemadmin.CreateGroupInput
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	if strings.TrimSpace(input.Currency) == "" {
		settings, settingsErr := s.systemAdmin.GetSettings(request.Context())
		if settingsErr != nil {
			writeProblem(response, request, settingsErr)
			return
		}
		input.Currency = settings.DefaultCurrency.Value
	}
	item, err := s.systemAdmin.CreateGroup(request.Context(), principal.UserID, input, s.groups.TokenSealer)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(item.Version))
	writeJSON(response, http.StatusCreated, s.systemGroupInvitationResponse(item))
}

func (s *Server) handleSystemGroupDeletionImpact(response http.ResponseWriter, request *http.Request) {
	principal, err := s.systemAdministrator(request)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	impact, err := s.systemAdmin.GetDeletionImpact(request.Context(), principal.UserID, request.PathValue("groupID"))
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(impact.Version))
	writeJSON(response, http.StatusOK, impact)
}

func (s *Server) handleArchiveSystemGroup(response http.ResponseWriter, request *http.Request) {
	s.handleSystemGroupLifecycle(response, request, s.systemAdmin.ArchiveGroup)
}

func (s *Server) handleRestoreSystemGroup(response http.ResponseWriter, request *http.Request) {
	s.handleSystemGroupLifecycle(response, request, s.systemAdmin.RestoreGroup)
}

func (s *Server) handleResendSystemGroupInvitation(response http.ResponseWriter, request *http.Request) {
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
	item, err := s.systemAdmin.ResendProvisioningInvitation(request.Context(), principal.UserID, request.PathValue("groupID"), expected, s.groups.TokenSealer)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(item.Version))
	writeJSON(response, http.StatusOK, s.systemGroupInvitationResponse(item))
}

func (s *Server) handleSystemGroupLifecycle(response http.ResponseWriter, request *http.Request, operation func(context.Context, string, string, int64) (systemadmin.ManagedGroup, error)) {
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
	item, err := operation(request.Context(), principal.UserID, request.PathValue("groupID"), expected)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	response.Header().Set("ETag", versionETag(item.Version))
	writeJSON(response, http.StatusOK, item)
}

func (s *Server) handlePurgeSystemGroup(response http.ResponseWriter, request *http.Request) {
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
	var input systemadmin.PurgeGroupInput
	if err := decodeJSON(response, request, &input); err != nil {
		writeProblem(response, request, err)
		return
	}
	input.ExpectedVersion = expected
	impact, err := s.systemAdmin.PurgeGroup(request.Context(), principal.UserID, request.PathValue("groupID"), input)
	var maintenanceWarning *systemadmin.PurgePostCommitWarning
	if err != nil && !errors.As(err, &maintenanceWarning) {
		writeProblem(response, request, err)
		return
	}
	if maintenanceWarning != nil {
		s.logger.Warn("group purge committed with deferred WAL checkpoint", "error", maintenanceWarning)
	}
	if _, err := s.systemAdmin.RunMediaGarbageCollection(request.Context(), s.config.DataDirectory, 100); err != nil {
		s.logger.Error("run post-purge media garbage collection", "error", err)
	}
	writeJSON(response, http.StatusOK, impact)
}

func (s *Server) handleSystemAudit(response http.ResponseWriter, request *http.Request) {
	if _, err := s.systemAdministrator(request); err != nil {
		writeProblem(response, request, err)
		return
	}
	query := auditTableQuery(request)
	page, err := s.systemAdmin.QueryAudit(request.Context(), query)
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeTablePageHeaders(response, page.NextCursor, query.Limit)
	writeJSON(response, http.StatusOK, map[string]any{"items": page.Items})
}

func (s *Server) handleSystemAuditFilterOptions(response http.ResponseWriter, request *http.Request) {
	if _, err := s.systemAdministrator(request); err != nil {
		writeProblem(response, request, err)
		return
	}
	options, err := s.systemAdmin.ListAuditFilterOptions(request.Context())
	if err != nil {
		writeProblem(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, options)
}

func parseSMTPRevision(request *http.Request) int64 {
	value, _ := strconv.ParseInt(request.Header.Get("X-SMTP-Revision"), 10, 64)
	return value
}
