package system

import (
	"os"
	"strings"

	"github.com/DasLukas/TeamTaler/internal/config"
)

// DefaultsFromConfig maps validated process configuration into runtime-setting
// defaults and records which values came from explicitly configured environment
// variables. Database overrides are deliberately not consulted. The returned
// Defaults can be passed directly to NewService.
// Example: defaults := DefaultsFromConfig(cfg).
func DefaultsFromConfig(configuration config.Config) Defaults {
	instanceDefaults := configuration.InstanceDefaults
	smtpDefaults := configuration.SMTP
	if !smtpDefaults.Enabled && smtpDefaults.Port == 0 {
		smtpDefaults.Port = config.DefaultSMTPPort
	}
	if smtpDefaults.TLSMode == "" {
		smtpDefaults.TLSMode = config.SMTPTLSModeStartTLS
	}
	legacyLiteral := instanceDefaults.InstanceName == ""
	if legacyLiteral {
		// Preserve construction compatibility for embedded/test callers that build
		// Config literals instead of using config.Load.
		instanceDefaults.InstanceName = "TeamTaler"
		instanceDefaults.DefaultCurrency = "EUR"
		instanceDefaults.MediaUploadMaxBytes = config.DefaultMediaUploadBytes
		instanceDefaults.PublicJoinEnabled = true
	}
	maxRequestBytes := configuration.MaxRequestBytes
	if legacyLiteral && maxRequestBytes < MultipartRequestReserveBytes+MinimumMediaUploadBytes {
		maxRequestBytes = 0
	}
	defaults := Defaults{
		InstanceName:        instanceDefaults.InstanceName,
		DefaultCurrency:     instanceDefaults.DefaultCurrency,
		MediaUploadMaxBytes: instanceDefaults.MediaUploadMaxBytes,
		PublicJoinEnabled:   instanceDefaults.PublicJoinEnabled,
		MaintenanceMode:     instanceDefaults.MaintenanceMode,
		MaintenanceMessage:  instanceDefaults.MaintenanceMessage,
		MaxRequestBytes:     maxRequestBytes,
		SMTP: SMTPConfiguration{
			Enabled:             smtpDefaults.Enabled,
			Host:                smtpDefaults.Host,
			Port:                smtpDefaults.Port,
			TLSMode:             SMTPTLSMode(smtpDefaults.TLSMode),
			Username:            smtpDefaults.Username,
			Password:            smtpDefaults.Password,
			FromAddress:         smtpDefaults.FromAddress,
			FromName:            smtpDefaults.FromName,
			AllowPrivateNetwork: smtpDefaults.AllowPrivateNetwork,
			AllowedPrivateHost:  smtpDefaults.AllowedPrivateHost,
			AllowedPrivatePort:  smtpDefaults.AllowedPrivatePort,
		},
		Sources: make(map[SettingKey]SettingSource),
	}
	environmentSources := map[SettingKey]string{
		SettingInstanceName:        "TEAMTALER_INSTANCE_NAME",
		SettingDefaultCurrency:     "TEAMTALER_DEFAULT_CURRENCY",
		SettingMediaUploadMaxBytes: "TEAMTALER_MEDIA_UPLOAD_MAX_BYTES",
		SettingPublicJoinEnabled:   "TEAMTALER_PUBLIC_JOIN_ENABLED",
		SettingMaintenanceEnabled:  "TEAMTALER_MAINTENANCE_MODE",
		SettingMaintenanceMessage:  "TEAMTALER_MAINTENANCE_MESSAGE",
		SettingSMTPHost:            "TEAMTALER_SMTP_HOST",
		SettingSMTPPort:            "TEAMTALER_SMTP_PORT",
		SettingSMTPTLSMode:         "TEAMTALER_SMTP_TLS_MODE",
		SettingSMTPUsername:        "TEAMTALER_SMTP_USERNAME",
		SettingSMTPPassword:        "TEAMTALER_SMTP_PASSWORD",
		SettingSMTPFromAddress:     "TEAMTALER_SMTP_FROM_ADDRESS",
		SettingSMTPFromName:        "TEAMTALER_SMTP_FROM_NAME",
	}
	for key, variable := range environmentSources {
		if value, exists := os.LookupEnv(variable); exists && strings.TrimSpace(value) != "" {
			defaults.Sources[key] = SettingSourceEnvironment
		}
	}
	if configuration.SMTP.Enabled {
		defaults.Sources[SettingSMTPEnabled] = SettingSourceEnvironment
	}
	return defaults
}
