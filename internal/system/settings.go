package system

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/mail"
	"strconv"
	"strings"
	"unicode"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

const (
	settingTypeString  = "STRING"
	settingTypeInteger = "INTEGER"
	settingTypeBoolean = "BOOLEAN"
	settingTypeSecret  = "SECRET"
)

type settingsQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type settingsState struct {
	revision           int64
	smtpRevision       int64
	smtpTestStatus     SMTPTestStatus
	smtpTestedRevision sql.NullInt64
	smtpTestedAt       sql.NullString
	updatedAt          string
	updatedByUserID    sql.NullString
}

type storedOverride struct {
	key              SettingKey
	valueType        string
	valueText        sql.NullString
	secretCiphertext sql.NullString
	version          int64
	updatedAt        string
}

type loadedSettings struct {
	settings               Settings
	overrides              map[SettingKey]storedOverride
	smtpPasswordCiphertext string
}

type settingMutation struct {
	key              SettingKey
	valueType        string
	valueText        string
	secretCiphertext string
}

// GetSettings loads one transactionally consistent effective snapshot. It
// applies database overrides over host defaults, redacts the SMTP password, and
// returns malformed-storage or query errors. Authorization is intentionally
// separate so trusted CLI and runtime consumers can use the same service.
func (s Service) GetSettings(ctx context.Context) (Settings, error) {
	loaded, err := s.loadSettings(ctx, s.db)
	return loaded.settings, err
}

// ResolveSMTP returns the effective SMTP configuration, decrypting a database
// password override only for trusted runtime delivery or SMTP-test code. It
// returns an error when the stored envelope cannot be opened or no cipher was
// configured. The caller must never log the returned Password field.
func (s Service) ResolveSMTP(ctx context.Context) (SMTPConfiguration, error) {
	_, configuration, err := s.ResolveRuntime(ctx)
	return configuration, err
}

// ResolveRuntime loads one transactionally consistent settings snapshot and
// its decrypted SMTP configuration. The returned configuration's Enabled flag
// already reflects the revision test gate. Runtime workers and SMTP test flows
// use this method so an edit cannot mix authorization state from one revision
// with credentials from another. Callers must never log configuration.Password.
func (s Service) ResolveRuntime(ctx context.Context) (Settings, SMTPConfiguration, error) {
	loaded, err := s.loadSettings(ctx, s.db)
	if err != nil {
		return Settings{}, SMTPConfiguration{}, err
	}
	configuration, err := s.resolveSMTPPassword(loaded)
	if err != nil {
		return Settings{}, SMTPConfiguration{}, err
	}
	return loaded.settings, configuration, nil
}

// UpdateSettings validates and persists supplied overrides when expectedRevision
// matches and actorUserID remains an active system administrator inside the
// transaction. Changed SMTP connection fields invalidate the prior SMTP test
// and force delivery disabled until a new exact-revision test succeeds. It
// returns the resulting effective snapshot or authorization, validation,
// precondition, conflict, encryption, and storage errors.
func (s Service) UpdateSettings(ctx context.Context, actorUserID string, expectedRevision int64, patch SettingsPatch) (Settings, error) {
	return s.updateSettings(ctx, actorUserID, true, expectedRevision, patch)
}

// UpdateSettingsLocally is the trusted-host variant of UpdateSettings. It skips
// account authorization and records a NULL actor, but retains validation,
// optimistic concurrency, SMTP verification, and audit guarantees. It is
// intended only for the local admin CLI.
func (s Service) UpdateSettingsLocally(ctx context.Context, expectedRevision int64, patch SettingsPatch) (Settings, error) {
	return s.updateSettings(ctx, "", false, expectedRevision, patch)
}

func (s Service) updateSettings(ctx context.Context, actorUserID string, requireAdministrator bool, expectedRevision int64, patch SettingsPatch) (Settings, error) {
	if expectedRevision < 1 {
		return Settings{}, fmt.Errorf("%w: a current system-settings revision is required", domain.ErrPrecondition)
	}
	mutations, smtpConnectionChanged, err := s.patchMutations(patch)
	if err != nil {
		return Settings{}, err
	}
	var result Settings
	err = storage.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		if requireAdministrator {
			if err := requireAdministratorTx(ctx, tx, actorUserID); err != nil {
				return err
			}
		}
		state, err := readSettingsState(ctx, tx)
		if err != nil {
			return err
		}
		if state.revision != expectedRevision {
			return domain.ErrPrecondition
		}
		if len(mutations) == 0 {
			loaded, err := s.loadSettings(ctx, tx)
			if err == nil {
				result = loaded.settings
			}
			return err
		}

		now := platform.Timestamp(platform.Now())
		for _, mutation := range mutations {
			if err := putOverride(ctx, tx, mutation, actorUserID, now); err != nil {
				return err
			}
		}
		if smtpConnectionChanged {
			if _, err := tx.ExecContext(ctx, `UPDATE system_settings_state
				SET smtp_revision=smtp_revision+1,smtp_tested_revision=NULL,
					smtp_tested_at=NULL,smtp_tested_by_user_id=NULL,smtp_test_status='UNTESTED'
				WHERE singleton=1`); err != nil {
				return fmt.Errorf("invalidate SMTP settings test: %w", err)
			}
		}
		updateResult, err := tx.ExecContext(ctx, `UPDATE system_settings_state
			SET revision=revision+1,updated_at=?,updated_by_user_id=nullif(?,'')
			WHERE singleton=1 AND revision=?`, now, actorUserID, expectedRevision)
		if err != nil {
			return fmt.Errorf("advance system settings revision: %w", err)
		}
		if affected, err := updateResult.RowsAffected(); err != nil || affected != 1 {
			if err != nil {
				return fmt.Errorf("count system settings revision update: %w", err)
			}
			return domain.ErrPrecondition
		}
		loaded, err := s.loadSettings(ctx, tx)
		if err != nil {
			return err
		}
		if loaded.settings.SMTP.Enabled.Value {
			if !loaded.settings.SMTP.ConfigurationValid {
				return domain.ValidationError{Field: "smtp.enabled", Message: "requires a complete valid SMTP configuration"}
			}
			if loaded.settings.SMTP.RequiresTest && !smtpRevisionTested(loaded.settings.SMTP) {
				return fmt.Errorf("%w: SMTP configuration must be tested before it can be enabled", domain.ErrConflict)
			}
		}
		keys := make([]string, 0, len(mutations))
		for _, mutation := range mutations {
			keys = append(keys, string(mutation.key))
		}
		if err := RecordAudit(ctx, tx, actorUserID, "system.settings.updated", "system_settings", "singleton", map[string]any{
			"previousRevision": expectedRevision,
			"revision":         loaded.settings.Revision,
			"keys":             keys,
		}); err != nil {
			return err
		}
		result = loaded.settings
		return nil
	})
	return result, err
}

// ResetSettings removes the selected overrides when expectedRevision matches
// and actorUserID remains an active system administrator. Effective values then
// fall back to current host defaults. Resetting SMTP connection fields
// invalidates the prior test. It returns the resulting snapshot or validation,
// authorization, precondition, and storage errors.
func (s Service) ResetSettings(ctx context.Context, actorUserID string, expectedRevision int64, keys []SettingKey) (Settings, error) {
	return s.resetSettings(ctx, actorUserID, true, expectedRevision, keys)
}

// ResetSettingsLocally is the trusted-host variant of ResetSettings. It skips
// account authorization and records a NULL actor for local CLI use while
// retaining validation, concurrency, SMTP-test invalidation, and audit rules.
func (s Service) ResetSettingsLocally(ctx context.Context, expectedRevision int64, keys []SettingKey) (Settings, error) {
	return s.resetSettings(ctx, "", false, expectedRevision, keys)
}

func (s Service) resetSettings(ctx context.Context, actorUserID string, requireAdministrator bool, expectedRevision int64, keys []SettingKey) (Settings, error) {
	if expectedRevision < 1 {
		return Settings{}, fmt.Errorf("%w: a current system-settings revision is required", domain.ErrPrecondition)
	}
	uniqueKeys := make([]SettingKey, 0, len(keys))
	seen := make(map[SettingKey]struct{}, len(keys))
	for _, key := range keys {
		if !isSettingKey(key) {
			return Settings{}, domain.ValidationError{Field: "keys", Message: fmt.Sprintf("contains unsupported setting %q", key)}
		}
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		uniqueKeys = append(uniqueKeys, key)
	}
	var result Settings
	err := storage.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		if requireAdministrator {
			if err := requireAdministratorTx(ctx, tx, actorUserID); err != nil {
				return err
			}
		}
		state, err := readSettingsState(ctx, tx)
		if err != nil {
			return err
		}
		if state.revision != expectedRevision {
			return domain.ErrPrecondition
		}
		if len(uniqueKeys) == 0 {
			loaded, err := s.loadSettings(ctx, tx)
			if err == nil {
				result = loaded.settings
			}
			return err
		}

		removedKeys := make([]string, 0, len(uniqueKeys))
		smtpConnectionChanged := false
		for _, key := range uniqueKeys {
			deleteResult, err := tx.ExecContext(ctx, `DELETE FROM system_setting_overrides WHERE setting_key=?`, key)
			if err != nil {
				return fmt.Errorf("reset system setting %q: %w", key, err)
			}
			affected, err := deleteResult.RowsAffected()
			if err != nil {
				return fmt.Errorf("count reset system setting %q: %w", key, err)
			}
			if affected == 1 {
				removedKeys = append(removedKeys, string(key))
				smtpConnectionChanged = smtpConnectionChanged || isSMTPConnectionKey(key)
			}
		}
		if len(removedKeys) == 0 {
			loaded, err := s.loadSettings(ctx, tx)
			if err == nil {
				result = loaded.settings
			}
			return err
		}
		now := platform.Timestamp(platform.Now())
		if smtpConnectionChanged {
			if _, err := tx.ExecContext(ctx, `UPDATE system_settings_state
				SET smtp_revision=smtp_revision+1,smtp_tested_revision=NULL,
					smtp_tested_at=NULL,smtp_tested_by_user_id=NULL,smtp_test_status='UNTESTED'
				WHERE singleton=1`); err != nil {
				return fmt.Errorf("invalidate SMTP settings test after reset: %w", err)
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE system_settings_state
			SET revision=revision+1,updated_at=?,updated_by_user_id=nullif(?,'')
			WHERE singleton=1 AND revision=?`, now, actorUserID, expectedRevision); err != nil {
			return fmt.Errorf("advance reset system settings revision: %w", err)
		}
		loaded, err := s.loadSettings(ctx, tx)
		if err != nil {
			return err
		}
		if loaded.settings.SMTP.Enabled.Value && (!loaded.settings.SMTP.ConfigurationValid ||
			loaded.settings.SMTP.RequiresTest && !smtpRevisionTested(loaded.settings.SMTP)) {
			return fmt.Errorf("%w: reset would enable an incomplete or untested SMTP configuration", domain.ErrConflict)
		}
		if err := RecordAudit(ctx, tx, actorUserID, "system.settings.reset", "system_settings", "singleton", map[string]any{
			"previousRevision": expectedRevision,
			"revision":         loaded.settings.Revision,
			"keys":             removedKeys,
		}); err != nil {
			return err
		}
		result = loaded.settings
		return nil
	})
	return result, err
}

// MarkSMTPTested records that an external test delivery succeeded for exactly
// expectedSMTPRevision. expectedRevision protects the whole settings snapshot;
// actorUserID is transactionally revalidated as a current system administrator.
// It returns the updated snapshot or authorization, precondition, validation,
// conflict, and storage errors. This method does not send mail itself.
func (s Service) MarkSMTPTested(ctx context.Context, actorUserID string, expectedRevision, expectedSMTPRevision int64) (Settings, error) {
	return s.markSMTPTested(ctx, actorUserID, true, expectedRevision, expectedSMTPRevision)
}

// MarkSMTPTestedLocally is the trusted-host variant of MarkSMTPTested. It skips
// account authorization and records a NULL actor for local CLI use.
func (s Service) MarkSMTPTestedLocally(ctx context.Context, expectedRevision, expectedSMTPRevision int64) (Settings, error) {
	return s.markSMTPTested(ctx, "", false, expectedRevision, expectedSMTPRevision)
}

func (s Service) markSMTPTested(ctx context.Context, actorUserID string, requireAdministrator bool, expectedRevision, expectedSMTPRevision int64) (Settings, error) {
	if expectedRevision < 1 || expectedSMTPRevision < 1 {
		return Settings{}, fmt.Errorf("%w: current settings and SMTP revisions are required", domain.ErrPrecondition)
	}
	var result Settings
	err := storage.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		if requireAdministrator {
			if err := requireAdministratorTx(ctx, tx, actorUserID); err != nil {
				return err
			}
		}
		loaded, err := s.loadSettings(ctx, tx)
		if err != nil {
			return err
		}
		if loaded.settings.Revision != expectedRevision || loaded.settings.SMTP.Revision != expectedSMTPRevision {
			return domain.ErrPrecondition
		}
		if !loaded.settings.SMTP.RequiresTest {
			return fmt.Errorf("%w: host-default SMTP configuration does not require database verification", domain.ErrConflict)
		}
		if !loaded.settings.SMTP.ConfigurationValid {
			return domain.ValidationError{Field: "smtp", Message: "must be complete before it can be tested"}
		}
		now := platform.Timestamp(platform.Now())
		updateResult, err := tx.ExecContext(ctx, `UPDATE system_settings_state
			SET revision=revision+1,smtp_tested_revision=smtp_revision,smtp_tested_at=?,
				smtp_tested_by_user_id=nullif(?,''),smtp_test_status='VERIFIED',updated_at=?,updated_by_user_id=nullif(?,'')
			WHERE singleton=1 AND revision=? AND smtp_revision=?`,
			now, actorUserID, now, actorUserID, expectedRevision, expectedSMTPRevision)
		if err != nil {
			return fmt.Errorf("mark SMTP settings tested: %w", err)
		}
		if affected, err := updateResult.RowsAffected(); err != nil || affected != 1 {
			if err != nil {
				return fmt.Errorf("count SMTP tested update: %w", err)
			}
			return domain.ErrPrecondition
		}
		loaded, err = s.loadSettings(ctx, tx)
		if err != nil {
			return err
		}
		if err := RecordAudit(ctx, tx, actorUserID, "system.smtp.test_succeeded", "system_settings", "smtp", map[string]any{
			"smtpRevision": expectedSMTPRevision,
			"revision":     loaded.settings.Revision,
		}); err != nil {
			return err
		}
		result = loaded.settings
		return nil
	})
	return result, err
}

// MarkSMTPTestFailed records a failed external delivery for exactly the
// supplied settings and SMTP revisions. It stores no transport error detail,
// revalidates the system administrator transactionally, and returns the
// resulting redacted settings snapshot.
func (s Service) MarkSMTPTestFailed(ctx context.Context, actorUserID string, expectedRevision, expectedSMTPRevision int64) (Settings, error) {
	return s.markSMTPTestFailed(ctx, actorUserID, true, expectedRevision, expectedSMTPRevision)
}

// MarkSMTPTestFailedLocally is the trusted-host variant used by the local CLI.
// It preserves revision checks and audit but records a NULL actor.
func (s Service) MarkSMTPTestFailedLocally(ctx context.Context, expectedRevision, expectedSMTPRevision int64) (Settings, error) {
	return s.markSMTPTestFailed(ctx, "", false, expectedRevision, expectedSMTPRevision)
}

func (s Service) markSMTPTestFailed(ctx context.Context, actorUserID string, requireAdministrator bool, expectedRevision, expectedSMTPRevision int64) (Settings, error) {
	if expectedRevision < 1 || expectedSMTPRevision < 1 {
		return Settings{}, fmt.Errorf("%w: current settings and SMTP revisions are required", domain.ErrPrecondition)
	}
	var result Settings
	err := storage.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		if requireAdministrator {
			if err := requireAdministratorTx(ctx, tx, actorUserID); err != nil {
				return err
			}
		}
		loaded, err := s.loadSettings(ctx, tx)
		if err != nil {
			return err
		}
		if loaded.settings.Revision != expectedRevision || loaded.settings.SMTP.Revision != expectedSMTPRevision {
			return domain.ErrPrecondition
		}
		if !loaded.settings.SMTP.RequiresTest || !loaded.settings.SMTP.ConfigurationValid {
			return domain.ErrPrecondition
		}
		now := platform.Timestamp(platform.Now())
		updateResult, err := tx.ExecContext(ctx, `UPDATE system_settings_state
			SET revision=revision+1,smtp_test_status='FAILED',updated_at=?,updated_by_user_id=nullif(?,'')
			WHERE singleton=1 AND revision=? AND smtp_revision=?`, now, actorUserID, expectedRevision, expectedSMTPRevision)
		if err != nil {
			return fmt.Errorf("mark SMTP test failed: %w", err)
		}
		if affected, err := updateResult.RowsAffected(); err != nil || affected != 1 {
			if err != nil {
				return fmt.Errorf("count SMTP failed-test update: %w", err)
			}
			return domain.ErrPrecondition
		}
		loaded, err = s.loadSettings(ctx, tx)
		if err != nil {
			return err
		}
		if err := RecordAudit(ctx, tx, actorUserID, "system.smtp.test_failed", "system_settings", "smtp", map[string]any{
			"smtpRevision": expectedSMTPRevision,
			"revision":     loaded.settings.Revision,
		}); err != nil {
			return err
		}
		result = loaded.settings
		return nil
	})
	return result, err
}

func (s Service) patchMutations(patch SettingsPatch) ([]settingMutation, bool, error) {
	mutations := make([]settingMutation, 0, 14)
	if patch.InstanceName != nil {
		value := strings.TrimSpace(*patch.InstanceName)
		if err := validateInstanceName(value); err != nil {
			return nil, false, err
		}
		mutations = append(mutations, textMutation(SettingInstanceName, value))
	}
	if patch.DefaultCurrency != nil {
		value := strings.ToUpper(strings.TrimSpace(*patch.DefaultCurrency))
		if err := validateCurrency(value); err != nil {
			return nil, false, err
		}
		mutations = append(mutations, textMutation(SettingDefaultCurrency, value))
	}
	if patch.MediaUploadMaxBytes != nil {
		if err := validateMediaUploadLimit(*patch.MediaUploadMaxBytes, MaximumMediaUploadBytes); err != nil {
			return nil, false, err
		}
		mutations = append(mutations, integerMutation(SettingMediaUploadMaxBytes, *patch.MediaUploadMaxBytes))
	}
	if patch.PublicJoinEnabled != nil {
		mutations = append(mutations, booleanMutation(SettingPublicJoinEnabled, *patch.PublicJoinEnabled))
	}
	if patch.MaintenanceMode != nil {
		mutations = append(mutations, booleanMutation(SettingMaintenanceEnabled, *patch.MaintenanceMode))
	}
	if patch.MaintenanceMessage != nil {
		value := strings.TrimSpace(*patch.MaintenanceMessage)
		if err := validateMaintenanceMessage(value); err != nil {
			return nil, false, err
		}
		mutations = append(mutations, textMutation(SettingMaintenanceMessage, value))
	}

	smtpConnectionChanged := false
	if patch.SMTP != nil {
		smtp := patch.SMTP
		if smtp.Enabled != nil {
			mutations = append(mutations, booleanMutation(SettingSMTPEnabled, *smtp.Enabled))
		}
		if smtp.Host != nil {
			value := normalizeSMTPHost(*smtp.Host)
			if err := validateSMTPHost(value); err != nil {
				return nil, false, err
			}
			mutations = append(mutations, textMutation(SettingSMTPHost, value))
			smtpConnectionChanged = true
		}
		if smtp.Port != nil {
			if *smtp.Port < 1 || *smtp.Port > 65535 {
				return nil, false, domain.ValidationError{Field: "smtp.port", Message: "must be between 1 and 65535"}
			}
			mutations = append(mutations, integerMutation(SettingSMTPPort, int64(*smtp.Port)))
			smtpConnectionChanged = true
		}
		if smtp.TLSMode != nil {
			mode := SMTPTLSMode(strings.ToLower(strings.TrimSpace(string(*smtp.TLSMode))))
			if mode != SMTPTLSModeStartTLS && mode != SMTPTLSModeTLS {
				return nil, false, domain.ValidationError{Field: "smtp.tlsMode", Message: "must be starttls or tls"}
			}
			mutations = append(mutations, textMutation(SettingSMTPTLSMode, string(mode)))
			smtpConnectionChanged = true
		}
		if smtp.Username != nil {
			value := strings.TrimSpace(*smtp.Username)
			if value == "" || len(value) > 254 || containsControlCharacter(value) {
				return nil, false, domain.ValidationError{Field: "smtp.username", Message: "must contain 1 to 254 characters without control characters"}
			}
			mutations = append(mutations, textMutation(SettingSMTPUsername, value))
			smtpConnectionChanged = true
		}
		if smtp.Password != nil {
			if len(*smtp.Password) < 1 || len(*smtp.Password) > 1024 || strings.ContainsRune(*smtp.Password, '\x00') {
				return nil, false, domain.ValidationError{Field: "smtp.password", Message: "must contain 1 to 1024 characters without NUL bytes"}
			}
			if s.passwordCipher == nil {
				return nil, false, fmt.Errorf("%w: SMTP password encryption is unavailable", domain.ErrServiceUnavailable)
			}
			encrypted, err := s.passwordCipher.Seal(*smtp.Password)
			if err != nil {
				return nil, false, fmt.Errorf("encrypt SMTP password: %w", err)
			}
			mutations = append(mutations, settingMutation{key: SettingSMTPPassword, valueType: settingTypeSecret, secretCiphertext: encrypted})
			smtpConnectionChanged = true
		}
		if smtp.FromAddress != nil {
			value := strings.TrimSpace(*smtp.FromAddress)
			if err := validateSMTPFromAddress(value); err != nil {
				return nil, false, err
			}
			mutations = append(mutations, textMutation(SettingSMTPFromAddress, value))
			smtpConnectionChanged = true
		}
		if smtp.FromName != nil {
			value := strings.TrimSpace(*smtp.FromName)
			if len(value) > 120 || containsControlCharacter(value) {
				return nil, false, domain.ValidationError{Field: "smtp.fromName", Message: "must contain at most 120 characters without control characters"}
			}
			mutations = append(mutations, textMutation(SettingSMTPFromName, value))
			smtpConnectionChanged = true
		}
	}
	if smtpConnectionChanged {
		if patch.SMTP != nil && patch.SMTP.Enabled != nil && *patch.SMTP.Enabled {
			return nil, false, fmt.Errorf("%w: changed SMTP configuration must be saved disabled and tested before enabling", domain.ErrConflict)
		}
		mutations = replaceMutation(mutations, booleanMutation(SettingSMTPEnabled, false))
	}
	return mutations, smtpConnectionChanged, nil
}

func (s Service) loadSettings(ctx context.Context, queryer settingsQueryer) (loadedSettings, error) {
	state, err := readSettingsState(ctx, queryer)
	if err != nil {
		return loadedSettings{}, err
	}
	overrides, err := readOverrides(ctx, queryer)
	if err != nil {
		return loadedSettings{}, err
	}
	settings := Settings{
		Revision:                  state.revision,
		InstanceName:              stringSetting(s.defaults, overrides, SettingInstanceName, s.defaults.InstanceName),
		DefaultCurrency:           stringSetting(s.defaults, overrides, SettingDefaultCurrency, s.defaults.DefaultCurrency),
		MediaUploadMaxBytes:       int64Setting(s.defaults, overrides, SettingMediaUploadMaxBytes, s.defaults.MediaUploadMaxBytes),
		MediaUploadHardLimitBytes: MaximumMediaUploadBytes,
		PublicJoinEnabled:         boolSetting(s.defaults, overrides, SettingPublicJoinEnabled, s.defaults.PublicJoinEnabled),
		MaintenanceMode:           boolSetting(s.defaults, overrides, SettingMaintenanceEnabled, s.defaults.MaintenanceMode),
		MaintenanceMessage:        stringSetting(s.defaults, overrides, SettingMaintenanceMessage, s.defaults.MaintenanceMessage),
		UpdatedAt:                 state.updatedAt,
	}
	if state.updatedByUserID.Valid {
		value := state.updatedByUserID.String
		settings.UpdatedByUserID = &value
	}
	settings.SMTP = SMTPSettings{
		Enabled:     boolSetting(s.defaults, overrides, SettingSMTPEnabled, s.defaults.SMTP.Enabled),
		Host:        stringSetting(s.defaults, overrides, SettingSMTPHost, s.defaults.SMTP.Host),
		Port:        intSetting(s.defaults, overrides, SettingSMTPPort, s.defaults.SMTP.Port),
		TLSMode:     smtpTLSSetting(s.defaults, overrides, s.defaults.SMTP.TLSMode),
		Username:    stringSetting(s.defaults, overrides, SettingSMTPUsername, s.defaults.SMTP.Username),
		Password:    secretSetting(s.defaults, overrides, s.defaults.SMTP.Password != ""),
		FromAddress: stringSetting(s.defaults, overrides, SettingSMTPFromAddress, s.defaults.SMTP.FromAddress),
		FromName:    stringSetting(s.defaults, overrides, SettingSMTPFromName, s.defaults.SMTP.FromName),
		Revision:    state.smtpRevision,
		TestStatus:  state.smtpTestStatus,
	}
	if state.smtpTestedRevision.Valid {
		value := state.smtpTestedRevision.Int64
		settings.SMTP.TestedRevision = &value
	}
	settings.SMTP.TestedAt = state.smtpTestedAt.String
	settings.SMTP.RequiresTest = hasSMTPConnectionOverride(overrides)
	settings.SMTP.ConfigurationValid = redactedSMTPConfigurationValid(settings.SMTP)
	if passwordOverride, found := overrides[SettingSMTPPassword]; found {
		if s.passwordCipher == nil {
			settings.SMTP.ConfigurationValid = false
		} else if _, err := s.passwordCipher.Open(passwordOverride.secretCiphertext.String); err != nil {
			settings.SMTP.ConfigurationValid = false
		}
	}
	settings.SMTP.Active = settings.SMTP.Enabled.Value && settings.SMTP.ConfigurationValid &&
		(!settings.SMTP.RequiresTest || smtpRevisionTested(settings.SMTP))
	loaded := loadedSettings{settings: settings, overrides: overrides}
	if passwordOverride, found := overrides[SettingSMTPPassword]; found {
		loaded.smtpPasswordCiphertext = passwordOverride.secretCiphertext.String
	}
	return loaded, nil
}

func (s Service) resolveSMTPPassword(loaded loadedSettings) (SMTPConfiguration, error) {
	configuration := SMTPConfiguration{
		Enabled:             loaded.settings.SMTP.Active,
		Host:                loaded.settings.SMTP.Host.Value,
		Port:                loaded.settings.SMTP.Port.Value,
		TLSMode:             loaded.settings.SMTP.TLSMode.Value,
		Username:            loaded.settings.SMTP.Username.Value,
		FromAddress:         loaded.settings.SMTP.FromAddress.Value,
		FromName:            loaded.settings.SMTP.FromName.Value,
		Password:            s.defaults.SMTP.Password,
		AllowPrivateNetwork: s.defaults.SMTP.AllowPrivateNetwork,
		AllowedPrivateHost:  s.defaults.SMTP.AllowedPrivateHost,
		AllowedPrivatePort:  s.defaults.SMTP.AllowedPrivatePort,
	}
	if loaded.smtpPasswordCiphertext != "" {
		if s.passwordCipher == nil {
			return SMTPConfiguration{}, fmt.Errorf("%w: SMTP password decryption is unavailable", domain.ErrServiceUnavailable)
		}
		password, err := s.passwordCipher.Open(loaded.smtpPasswordCiphertext)
		if err != nil {
			return SMTPConfiguration{}, fmt.Errorf("decrypt SMTP password: %w", err)
		}
		configuration.Password = password
	}
	return configuration, nil
}

func readSettingsState(ctx context.Context, queryer settingsQueryer) (settingsState, error) {
	var state settingsState
	err := queryer.QueryRowContext(ctx, `SELECT revision,smtp_revision,smtp_test_status,smtp_tested_revision,
		smtp_tested_at,updated_at,updated_by_user_id
		FROM system_settings_state WHERE singleton=1`).Scan(
		&state.revision, &state.smtpRevision, &state.smtpTestStatus, &state.smtpTestedRevision,
		&state.smtpTestedAt, &state.updatedAt, &state.updatedByUserID)
	if errors.Is(err, sql.ErrNoRows) {
		return settingsState{}, fmt.Errorf("system settings state is missing")
	}
	if err != nil {
		return settingsState{}, fmt.Errorf("read system settings state: %w", err)
	}
	return state, nil
}

func readOverrides(ctx context.Context, queryer settingsQueryer) (map[SettingKey]storedOverride, error) {
	rows, err := queryer.QueryContext(ctx, `SELECT setting_key,value_type,value_text,
		secret_ciphertext,version,updated_at FROM system_setting_overrides ORDER BY setting_key`)
	if err != nil {
		return nil, fmt.Errorf("read system setting overrides: %w", err)
	}
	defer rows.Close()
	overrides := make(map[SettingKey]storedOverride)
	for rows.Next() {
		var override storedOverride
		if err := rows.Scan(&override.key, &override.valueType, &override.valueText,
			&override.secretCiphertext, &override.version, &override.updatedAt); err != nil {
			return nil, fmt.Errorf("scan system setting override: %w", err)
		}
		if !isSettingKey(override.key) {
			return nil, fmt.Errorf("stored system setting key %q is unsupported", override.key)
		}
		if err := validateStoredOverride(override); err != nil {
			return nil, err
		}
		overrides[override.key] = override
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate system setting overrides: %w", err)
	}
	return overrides, nil
}

func validateStoredOverride(override storedOverride) error {
	expectedType := settingTypeString
	switch override.key {
	case SettingMediaUploadMaxBytes, SettingSMTPPort:
		expectedType = settingTypeInteger
	case SettingPublicJoinEnabled, SettingMaintenanceEnabled, SettingSMTPEnabled:
		expectedType = settingTypeBoolean
	case SettingSMTPPassword:
		expectedType = settingTypeSecret
	}
	if override.valueType != expectedType {
		return fmt.Errorf("stored system setting %q has unexpected type %q", override.key, override.valueType)
	}
	switch expectedType {
	case settingTypeInteger:
		if _, err := strconv.ParseInt(override.valueText.String, 10, 64); err != nil {
			return fmt.Errorf("stored system setting %q has invalid integer value", override.key)
		}
	case settingTypeBoolean:
		if override.valueText.String != "true" && override.valueText.String != "false" {
			return fmt.Errorf("stored system setting %q has invalid boolean value", override.key)
		}
	case settingTypeSecret:
		if !override.secretCiphertext.Valid || override.secretCiphertext.String == "" {
			return fmt.Errorf("stored system setting %q has an empty secret envelope", override.key)
		}
	}
	return nil
}

func putOverride(ctx context.Context, tx *sql.Tx, mutation settingMutation, actorUserID, now string) error {
	var valueText, ciphertext any
	if mutation.valueType == settingTypeSecret {
		ciphertext = mutation.secretCiphertext
	} else {
		valueText = mutation.valueText
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO system_setting_overrides(
		setting_key,value_type,value_text,secret_ciphertext,version,updated_at,updated_by_user_id
	) VALUES(?,?,?,?,1,?,nullif(?,''))
	ON CONFLICT(setting_key) DO UPDATE SET
		value_type=excluded.value_type,value_text=excluded.value_text,
		secret_ciphertext=excluded.secret_ciphertext,version=system_setting_overrides.version+1,
		updated_at=excluded.updated_at,updated_by_user_id=excluded.updated_by_user_id`,
		mutation.key, mutation.valueType, valueText, ciphertext, now, actorUserID)
	if err != nil {
		return fmt.Errorf("persist system setting %q: %w", mutation.key, err)
	}
	return nil
}

func textMutation(key SettingKey, value string) settingMutation {
	return settingMutation{key: key, valueType: settingTypeString, valueText: value}
}

func integerMutation(key SettingKey, value int64) settingMutation {
	return settingMutation{key: key, valueType: settingTypeInteger, valueText: strconv.FormatInt(value, 10)}
}

func booleanMutation(key SettingKey, value bool) settingMutation {
	return settingMutation{key: key, valueType: settingTypeBoolean, valueText: strconv.FormatBool(value)}
}

func replaceMutation(mutations []settingMutation, replacement settingMutation) []settingMutation {
	for index := range mutations {
		if mutations[index].key == replacement.key {
			mutations[index] = replacement
			return mutations
		}
	}
	return append(mutations, replacement)
}

func stringSetting(defaults Defaults, overrides map[SettingKey]storedOverride, key SettingKey, fallback string) Setting[string] {
	setting := Setting[string]{Value: fallback, Source: defaultSource(defaults, key)}
	if override, found := overrides[key]; found {
		setting.Value = override.valueText.String
		setting.Source = SettingSourceDatabase
		setting.OverrideVersion = override.version
		setting.UpdatedAt = override.updatedAt
	}
	return setting
}

func int64Setting(defaults Defaults, overrides map[SettingKey]storedOverride, key SettingKey, fallback int64) Setting[int64] {
	setting := Setting[int64]{Value: fallback, Source: defaultSource(defaults, key)}
	if override, found := overrides[key]; found {
		value, err := strconv.ParseInt(override.valueText.String, 10, 64)
		if err == nil {
			setting.Value = value
		} else {
			setting.Value = -1
		}
		setting.Source = SettingSourceDatabase
		setting.OverrideVersion = override.version
		setting.UpdatedAt = override.updatedAt
	}
	return setting
}

func intSetting(defaults Defaults, overrides map[SettingKey]storedOverride, key SettingKey, fallback int) Setting[int] {
	setting := Setting[int]{Value: fallback, Source: defaultSource(defaults, key)}
	if override, found := overrides[key]; found {
		value, err := strconv.Atoi(override.valueText.String)
		if err == nil {
			setting.Value = value
		} else {
			setting.Value = -1
		}
		setting.Source = SettingSourceDatabase
		setting.OverrideVersion = override.version
		setting.UpdatedAt = override.updatedAt
	}
	return setting
}

func boolSetting(defaults Defaults, overrides map[SettingKey]storedOverride, key SettingKey, fallback bool) Setting[bool] {
	setting := Setting[bool]{Value: fallback, Source: defaultSource(defaults, key)}
	if override, found := overrides[key]; found {
		setting.Value = override.valueText.String == "true"
		setting.Source = SettingSourceDatabase
		setting.OverrideVersion = override.version
		setting.UpdatedAt = override.updatedAt
	}
	return setting
}

func smtpTLSSetting(defaults Defaults, overrides map[SettingKey]storedOverride, fallback SMTPTLSMode) Setting[SMTPTLSMode] {
	setting := Setting[SMTPTLSMode]{Value: fallback, Source: defaultSource(defaults, SettingSMTPTLSMode)}
	if override, found := overrides[SettingSMTPTLSMode]; found {
		setting.Value = SMTPTLSMode(override.valueText.String)
		setting.Source = SettingSourceDatabase
		setting.OverrideVersion = override.version
		setting.UpdatedAt = override.updatedAt
	}
	return setting
}

func secretSetting(defaults Defaults, overrides map[SettingKey]storedOverride, fallbackConfigured bool) SecretSetting {
	setting := SecretSetting{Configured: fallbackConfigured, Source: defaultSource(defaults, SettingSMTPPassword)}
	if override, found := overrides[SettingSMTPPassword]; found {
		setting.Configured = override.secretCiphertext.Valid && override.secretCiphertext.String != ""
		setting.Source = SettingSourceDatabase
		setting.OverrideVersion = override.version
		setting.UpdatedAt = override.updatedAt
	}
	return setting
}

func hasSMTPConnectionOverride(overrides map[SettingKey]storedOverride) bool {
	for key := range overrides {
		if isSMTPConnectionKey(key) {
			return true
		}
	}
	return false
}

func smtpRevisionTested(settings SMTPSettings) bool {
	return settings.TestedRevision != nil && *settings.TestedRevision == settings.Revision
}

func redactedSMTPConfigurationValid(settings SMTPSettings) bool {
	configuration := SMTPConfiguration{
		Enabled:     true,
		Host:        settings.Host.Value,
		Port:        settings.Port.Value,
		TLSMode:     settings.TLSMode.Value,
		Username:    settings.Username.Value,
		Password:    "configured",
		FromAddress: settings.FromAddress.Value,
		FromName:    settings.FromName.Value,
	}
	if !settings.Password.Configured {
		return false
	}
	return validateSMTPConfiguration(configuration) == nil
}

func validateInstanceName(value string) error {
	if strings.TrimSpace(value) == "" || len(value) > 120 || containsControlCharacter(value) {
		return domain.ValidationError{Field: "instanceName", Message: "must contain 1 to 120 characters without control characters"}
	}
	return nil
}

func validateCurrency(value string) error {
	if !platform.IsCurrencyCode(value) {
		return domain.ValidationError{Field: "defaultCurrency", Message: "must be a three-letter ISO 4217 code"}
	}
	return nil
}

func validateMediaUploadLimit(value, hardLimit int64) error {
	if value < MinimumMediaUploadBytes || value > hardLimit || value%MediaUploadUnitBytes != 0 {
		return domain.ValidationError{Field: "mediaUploadMaxBytes", Message: fmt.Sprintf("must be a whole MiB value between %d and %d bytes", MinimumMediaUploadBytes, hardLimit)}
	}
	return nil
}

func validateMaintenanceMessage(value string) error {
	if len(value) > 240 || containsControlCharacter(value) {
		return domain.ValidationError{Field: "maintenanceMessage", Message: "must contain at most 240 characters without control characters"}
	}
	return nil
}

func validateSMTPConfiguration(configuration SMTPConfiguration) error {
	if err := validateSMTPHost(normalizeSMTPHost(configuration.Host)); err != nil {
		return err
	}
	if configuration.Port < 1 || configuration.Port > 65535 {
		return domain.ValidationError{Field: "smtp.port", Message: "must be between 1 and 65535"}
	}
	if configuration.TLSMode != SMTPTLSModeStartTLS && configuration.TLSMode != SMTPTLSModeTLS {
		return domain.ValidationError{Field: "smtp.tlsMode", Message: "must be starttls or tls"}
	}
	if strings.TrimSpace(configuration.Username) == "" || len(configuration.Username) > 254 || containsControlCharacter(configuration.Username) {
		return domain.ValidationError{Field: "smtp.username", Message: "must contain 1 to 254 characters without control characters"}
	}
	if configuration.Password == "" || len(configuration.Password) > 1024 || strings.ContainsRune(configuration.Password, '\x00') {
		return domain.ValidationError{Field: "smtp.password", Message: "must contain 1 to 1024 characters without NUL bytes"}
	}
	if err := validateSMTPFromAddress(strings.TrimSpace(configuration.FromAddress)); err != nil {
		return err
	}
	if len(strings.TrimSpace(configuration.FromName)) > 120 || containsControlCharacter(configuration.FromName) {
		return domain.ValidationError{Field: "smtp.fromName", Message: "must contain at most 120 characters without control characters"}
	}
	return nil
}

func normalizeSMTPHost(value string) string {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "[") && strings.HasSuffix(value, "]") {
		return strings.TrimSuffix(strings.TrimPrefix(value, "["), "]")
	}
	return value
}

func validateSMTPHost(value string) error {
	if value == "" || len(value) > 253 || containsControlCharacter(value) || strings.ContainsAny(value, " /@") {
		return domain.ValidationError{Field: "smtp.host", Message: "must be a hostname or IP address without a scheme, path, or port"}
	}
	if parsedHost, parsedPort, err := net.SplitHostPort(value); err == nil && parsedHost != "" && parsedPort != "" {
		return domain.ValidationError{Field: "smtp.host", Message: "must not include a port"}
	}
	if strings.Contains(value, ":") && net.ParseIP(value) == nil {
		return domain.ValidationError{Field: "smtp.host", Message: "must be a valid hostname or IP address"}
	}
	return nil
}

func validateSMTPFromAddress(value string) error {
	if containsControlCharacter(value) {
		return domain.ValidationError{Field: "smtp.fromAddress", Message: "must not contain control characters"}
	}
	parsed, err := mail.ParseAddress(value)
	if err != nil || len(value) > 254 || parsed.Name != "" || parsed.Address != value || !strings.Contains(value, "@") || !isASCII(value) {
		return domain.ValidationError{Field: "smtp.fromAddress", Message: "must be one ASCII mailbox address without a display name"}
	}
	return nil
}

func containsControlCharacter(value string) bool {
	for _, character := range value {
		if unicode.IsControl(character) {
			return true
		}
	}
	return false
}

func isASCII(value string) bool {
	for _, character := range value {
		if character > unicode.MaxASCII {
			return false
		}
	}
	return true
}
