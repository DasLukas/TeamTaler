package system

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/DasLukas/TeamTaler/internal/config"
)

const (
	// MinimumMediaUploadBytes is the smallest configurable source upload limit.
	MinimumMediaUploadBytes int64 = config.MinimumMediaUploadBytes
	// MaximumMediaUploadBytes is the application-level source upload ceiling.
	MaximumMediaUploadBytes int64 = config.MaximumMediaUploadBytes
	// MediaUploadUnitBytes is the required increment for source upload limits.
	MediaUploadUnitBytes int64 = config.MediaUploadUnitBytes
	// MinimumAttachmentUploadBytes is the smallest configurable receipt limit.
	MinimumAttachmentUploadBytes int64 = config.MinimumAttachmentUploadBytes
	// MaximumAttachmentUploadBytes is the application-level receipt ceiling.
	MaximumAttachmentUploadBytes int64 = config.MaximumAttachmentUploadBytes
	// MultipartRequestReserveBytes leaves space for multipart framing and HTTP
	// fields when the HTTP layer derives a request limit from the live media limit.
	MultipartRequestReserveBytes int64 = config.MultipartRequestReserve
)

// NewService constructs an instance-administration service. db must reference a
// migrated TeamTaler database, defaults must be valid, and passwordCipher may be
// nil only while no database SMTP-password override needs to be written or
// resolved. It returns validation errors for unsafe defaults or source metadata.
// Example: service, err := NewService(db, defaults, cipher,
// WithWebPushSecretCipher(pushSecrets)).
func NewService(db *sql.DB, defaults Defaults, passwordCipher PasswordCipher, options ...ServiceOption) (Service, error) {
	if db == nil {
		return Service{}, fmt.Errorf("system database is required")
	}
	defaults.Sources = cloneSources(defaults.Sources)
	if defaults.AttachmentUploadMaxBytes == 0 {
		defaults.AttachmentUploadMaxBytes = config.DefaultAttachmentUploadBytes
	}
	if strings.TrimSpace(defaults.TimeZone) == "" {
		defaults.TimeZone = "Europe/Berlin"
	}
	if err := validateDefaults(defaults); err != nil {
		return Service{}, err
	}
	service := Service{db: db, defaults: defaults, passwordCipher: passwordCipher}
	for _, option := range options {
		if option != nil {
			option(&service)
		}
	}
	return service, nil
}

// ServiceOption configures optional system-service secret integrations.
type ServiceOption func(*Service)

// WithWebPushSecretCipher supplies purpose-separated VAPID-secret encryption.
// A nil cipher leaves database Web Push overrides inactive but resettable.
func WithWebPushSecretCipher(cipher WebPushSecretCipher) ServiceOption {
	return func(service *Service) { service.webPushCipher = cipher }
}

// WithLegalDocumentFiles configures optional live host-file fallbacks for the
// imprint and privacy policy. Database overrides retain precedence. Empty paths
// disable the corresponding file source.
func WithLegalDocumentFiles(imprintPath, privacyPolicyPath string) ServiceOption {
	return func(service *Service) {
		service.legalFiles = map[LegalDocumentKey]string{
			LegalDocumentImprint:       strings.TrimSpace(imprintPath),
			LegalDocumentPrivacyPolicy: strings.TrimSpace(privacyPolicyPath),
		}
	}
}

func validateDefaults(defaults Defaults) error {
	if err := validateInstanceName(defaults.InstanceName); err != nil {
		return fmt.Errorf("invalid default instance name: %w", err)
	}
	if err := validateCurrency(defaults.DefaultCurrency); err != nil {
		return fmt.Errorf("invalid default currency: %w", err)
	}
	if err := validateTimeZone(defaults.TimeZone); err != nil {
		return fmt.Errorf("invalid default time zone: %w", err)
	}
	if err := validateMediaUploadLimit(defaults.MediaUploadMaxBytes, MaximumMediaUploadBytes); err != nil {
		return fmt.Errorf("invalid default media upload limit: %w", err)
	}
	if err := validateMediaUploadLimit(defaults.AttachmentUploadMaxBytes, MaximumAttachmentUploadBytes); err != nil {
		return fmt.Errorf("invalid default attachment upload limit: %w", err)
	}
	if err := validateMaintenanceMessage(defaults.MaintenanceMessage); err != nil {
		return fmt.Errorf("invalid default maintenance message: %w", err)
	}
	if defaults.SMTP.Enabled {
		if err := validateSMTPConfiguration(defaults.SMTP); err != nil {
			return fmt.Errorf("invalid default SMTP configuration: %w", err)
		}
	}
	if defaults.WebPush.Enabled {
		if err := validateWebPushConfiguration(defaults.WebPush); err != nil {
			return fmt.Errorf("invalid default Web Push configuration: %w", err)
		}
	}
	for key, source := range defaults.Sources {
		if !isSettingKey(key) {
			return fmt.Errorf("invalid default source key %q", key)
		}
		if source != SettingSourceCode && source != SettingSourceEnvironment {
			return fmt.Errorf("invalid default source %q for %q", source, key)
		}
	}
	return nil
}

// ResolveTimeZoneTx returns the effective installation-wide IANA time zone from
// the caller's transaction snapshot.
//
// Parameters:
//   - ctx: Request or worker context.
//   - tx: Open database transaction used for a consistent settings snapshot.
//
// Returns:
//   - string: Valid effective IANA time zone.
//   - error: Storage or persisted-settings validation failure.
//
// Example: zone, err := service.ResolveTimeZoneTx(ctx, tx).
func (s Service) ResolveTimeZoneTx(ctx context.Context, tx *sql.Tx) (string, error) {
	if tx == nil {
		return "", fmt.Errorf("resolve system time zone: transaction is required")
	}
	loaded, err := s.loadSettings(ctx, tx)
	if err != nil {
		return "", err
	}
	return loaded.settings.TimeZone.Value, nil
}

func validateTimeZone(value string) error {
	value = strings.TrimSpace(value)
	if value == "" || value == "Local" || len(value) > 120 {
		return fmt.Errorf("must contain a valid IANA time zone")
	}
	if _, err := time.LoadLocation(value); err != nil {
		return fmt.Errorf("must contain a valid IANA time zone")
	}
	return nil
}

func cloneSources(sources map[SettingKey]SettingSource) map[SettingKey]SettingSource {
	if len(sources) == 0 {
		return nil
	}
	cloned := make(map[SettingKey]SettingSource, len(sources))
	for key, source := range sources {
		cloned[key] = source
	}
	return cloned
}

func defaultSource(defaults Defaults, key SettingKey) SettingSource {
	if source := defaults.Sources[key]; source == SettingSourceEnvironment {
		return source
	}
	return SettingSourceCode
}

func isSettingKey(candidate SettingKey) bool {
	for _, key := range allSettingKeys {
		if key == candidate {
			return true
		}
	}
	return false
}

func isSMTPConnectionKey(key SettingKey) bool {
	switch key {
	case SettingSMTPHost, SettingSMTPPort, SettingSMTPTLSMode, SettingSMTPUsername,
		SettingSMTPPassword, SettingSMTPFromAddress, SettingSMTPFromName:
		return true
	default:
		return false
	}
}

func isWebPushConfigurationKey(key SettingKey) bool {
	return key == SettingWebPushSubject || key == SettingWebPushVAPIDPrivateKey
}
