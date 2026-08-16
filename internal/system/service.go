package system

import (
	"database/sql"
	"fmt"

	"github.com/DasLukas/TeamTaler/internal/config"
)

const (
	// MinimumMediaUploadBytes is the smallest configurable source upload limit.
	MinimumMediaUploadBytes int64 = config.MinimumMediaUploadBytes
	// MaximumMediaUploadBytes is the application-level source upload ceiling.
	MaximumMediaUploadBytes int64 = config.MaximumMediaUploadBytes
	// MediaUploadUnitBytes is the required increment for source upload limits.
	MediaUploadUnitBytes int64 = config.MediaUploadUnitBytes
	// MultipartRequestReserveBytes leaves space for multipart framing and HTTP
	// fields when the HTTP layer derives a request limit from the live media limit.
	MultipartRequestReserveBytes int64 = config.MultipartRequestReserve
)

// NewService constructs an instance-administration service. db must reference a
// migrated TeamTaler database, defaults must be valid, and passwordCipher may be
// nil only while no database SMTP-password override needs to be written or
// resolved. It returns validation errors for unsafe defaults or source metadata.
// Example: service, err := NewService(db, defaults, cipher).
func NewService(db *sql.DB, defaults Defaults, passwordCipher PasswordCipher) (Service, error) {
	if db == nil {
		return Service{}, fmt.Errorf("system database is required")
	}
	defaults.Sources = cloneSources(defaults.Sources)
	if err := validateDefaults(defaults); err != nil {
		return Service{}, err
	}
	return Service{db: db, defaults: defaults, passwordCipher: passwordCipher}, nil
}

func validateDefaults(defaults Defaults) error {
	if err := validateInstanceName(defaults.InstanceName); err != nil {
		return fmt.Errorf("invalid default instance name: %w", err)
	}
	if err := validateCurrency(defaults.DefaultCurrency); err != nil {
		return fmt.Errorf("invalid default currency: %w", err)
	}
	if err := validateMediaUploadLimit(defaults.MediaUploadMaxBytes, MaximumMediaUploadBytes); err != nil {
		return fmt.Errorf("invalid default media upload limit: %w", err)
	}
	if err := validateMaintenanceMessage(defaults.MaintenanceMessage); err != nil {
		return fmt.Errorf("invalid default maintenance message: %w", err)
	}
	if defaults.SMTP.Enabled {
		if err := validateSMTPConfiguration(defaults.SMTP); err != nil {
			return fmt.Errorf("invalid default SMTP configuration: %w", err)
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
