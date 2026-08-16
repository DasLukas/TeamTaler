package system

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/config"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestSystemAdministratorAssignmentsAreGlobalLiveAndProtectFinalActiveAdministrator(t *testing.T) {
	ctx := context.Background()
	db, service := openSystemService(t)
	defer db.Close()
	insertSystemTestUser(t, db, "user-one", "one@example.test", true)
	insertSystemTestUser(t, db, "user-two", "two@example.test", true)

	first, err := service.GrantAdministratorByEmail(ctx, "ONE@example.test", "")
	if err != nil {
		t.Fatalf("grant first administrator: %v", err)
	}
	if first.UserID != "user-one" || first.Role != RoleSystemAdministrator || first.GrantedByUserID != nil {
		t.Fatalf("unexpected first assignment: %#v", first)
	}
	if err := service.RequireAdministrator(ctx, "user-one"); err != nil {
		t.Fatalf("require first administrator: %v", err)
	}
	roles, err := service.RolesForUser(ctx, "user-one")
	if err != nil || len(roles) != 1 || roles[0] != RoleSystemAdministrator {
		t.Fatalf("roles=%v err=%v", roles, err)
	}
	if _, err := service.GrantAdministrator(ctx, "user-one", ""); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("duplicate grant error=%v, want conflict", err)
	}
	if err := service.RevokeAdministrator(ctx, "user-one", ""); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("final administrator revoke error=%v, want conflict", err)
	}

	if _, err := service.GrantAdministrator(ctx, "user-two", "user-one"); err != nil {
		t.Fatalf("grant second administrator: %v", err)
	}
	if err := service.RevokeAdministratorByEmail(ctx, "ONE@example.test", "user-two"); err != nil {
		t.Fatalf("revoke first administrator: %v", err)
	}
	if err := service.RequireAdministrator(ctx, "user-one"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("revoked administrator require error=%v, want forbidden", err)
	}
	assignments, err := service.ListAdministrators(ctx)
	if err != nil || len(assignments) != 1 || assignments[0].UserID != "user-two" {
		t.Fatalf("administrators=%#v err=%v", assignments, err)
	}

	if _, err := db.ExecContext(ctx, `UPDATE users SET active=0 WHERE id='user-two'`); err != nil {
		t.Fatalf("deactivate remaining administrator: %v", err)
	}
	if err := service.RequireAdministrator(ctx, "user-two"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("inactive administrator require error=%v, want forbidden", err)
	}
	if err := service.RevokeAdministratorByEmail(ctx, "two@example.test", ""); err != nil {
		t.Fatalf("revoke inactive assignment: %v", err)
	}

	events, err := service.ListAudit(ctx, 20)
	if err != nil {
		t.Fatalf("list system audit: %v", err)
	}
	if len(events) != 4 {
		t.Fatalf("audit event count=%d, want 4", len(events))
	}
	for _, event := range events {
		if event.ActorUserID == nil {
			if event.ActorDisplayName != "" {
				t.Fatalf("system actor display name=%q, want empty", event.ActorDisplayName)
			}
			continue
		}
		want := map[string]string{"user-one": "user-one", "user-two": "user-two"}[*event.ActorUserID]
		if event.ActorDisplayName != want {
			t.Fatalf("actor %q display name=%q, want %q", *event.ActorUserID, event.ActorDisplayName, want)
		}
	}
}

func TestSettingsUseTypedOverridesOptimisticConcurrencyAndReset(t *testing.T) {
	ctx := context.Background()
	db, service := openSystemService(t)
	defer db.Close()
	insertSystemTestUser(t, db, "admin", "admin@example.test", true)
	if _, err := service.GrantAdministrator(ctx, "admin", ""); err != nil {
		t.Fatalf("grant administrator: %v", err)
	}
	insertSystemTestUser(t, db, "member", "member@example.test", true)

	initial, err := service.GetSettings(ctx)
	if err != nil {
		t.Fatalf("get initial settings: %v", err)
	}
	if initial.Revision != 1 || initial.InstanceName.Value != "Host TeamTaler" || initial.InstanceName.Source != SettingSourceEnvironment {
		t.Fatalf("unexpected initial settings: %#v", initial)
	}
	name := "Runtime TeamTaler"
	currency := "usd"
	uploadLimit := int64(24 << 20)
	publicJoin := false
	maintenance := true
	message := "Short maintenance"
	updated, err := service.UpdateSettings(ctx, "admin", initial.Revision, SettingsPatch{
		InstanceName:        &name,
		DefaultCurrency:     &currency,
		MediaUploadMaxBytes: &uploadLimit,
		PublicJoinEnabled:   &publicJoin,
		MaintenanceMode:     &maintenance,
		MaintenanceMessage:  &message,
	})
	if err != nil {
		t.Fatalf("update settings: %v", err)
	}
	if updated.Revision != 2 || updated.InstanceName.Value != name || updated.InstanceName.Source != SettingSourceDatabase || updated.InstanceName.OverrideVersion != 1 {
		t.Fatalf("unexpected updated instance setting: %#v", updated.InstanceName)
	}
	if updated.DefaultCurrency.Value != "USD" || updated.MediaUploadMaxBytes.Value != uploadLimit || updated.PublicJoinEnabled.Value || !updated.MaintenanceMode.Value {
		t.Fatalf("unexpected typed settings snapshot: %#v", updated)
	}
	if updated.MediaUploadHardLimitBytes != MaximumMediaUploadBytes {
		t.Fatalf("media hard limit=%d, want %d", updated.MediaUploadHardLimitBytes, MaximumMediaUploadBytes)
	}
	if _, err := service.UpdateSettings(ctx, "admin", initial.Revision, SettingsPatch{InstanceName: &name}); !errors.Is(err, domain.ErrPrecondition) {
		t.Fatalf("stale update error=%v, want precondition", err)
	}
	if _, err := service.UpdateSettings(ctx, "member", updated.Revision, SettingsPatch{InstanceName: &name}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("non-administrator update error=%v, want forbidden", err)
	}
	tooLarge := MaximumMediaUploadBytes + 1
	if _, err := service.UpdateSettings(ctx, "admin", updated.Revision, SettingsPatch{MediaUploadMaxBytes: &tooLarge}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("over-hard-limit update error=%v, want validation", err)
	}
	fractionalMiB := int64(24<<20) + (256 << 10)
	if _, err := service.UpdateSettings(ctx, "admin", updated.Revision, SettingsPatch{MediaUploadMaxBytes: &fractionalMiB}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("fractional-MiB update error=%v, want validation", err)
	}

	reset, err := service.ResetSettings(ctx, "admin", updated.Revision, []SettingKey{SettingInstanceName, SettingDefaultCurrency})
	if err != nil {
		t.Fatalf("reset settings: %v", err)
	}
	if reset.Revision != 3 || reset.InstanceName.Value != "Host TeamTaler" || reset.InstanceName.Source != SettingSourceEnvironment || reset.DefaultCurrency.Value != "EUR" {
		t.Fatalf("unexpected reset snapshot: %#v", reset)
	}
}

func TestSMTPOverridesAreEncryptedRedactedAndRevisionTested(t *testing.T) {
	ctx := context.Background()
	db, service := openSystemService(t)
	defer db.Close()
	insertSystemTestUser(t, db, "admin", "admin@example.test", true)
	if _, err := service.GrantAdministrator(ctx, "admin", ""); err != nil {
		t.Fatalf("grant administrator: %v", err)
	}
	initial, err := service.GetSettings(ctx)
	if err != nil {
		t.Fatalf("get initial settings: %v", err)
	}

	enabled := false
	host := "smtp.example.test"
	port := 587
	mode := SMTPTLSModeStartTLS
	username := "mailer@example.test"
	password := "smtp-secret-value"
	fromAddress := "teamtaler@example.test"
	fromName := "TeamTaler Mail"
	configured, err := service.UpdateSettings(ctx, "admin", initial.Revision, SettingsPatch{SMTP: &SMTPPatch{
		Enabled: &enabled, Host: &host, Port: &port, TLSMode: &mode,
		Username: &username, Password: &password, FromAddress: &fromAddress, FromName: &fromName,
	}})
	if err != nil {
		t.Fatalf("save SMTP override: %v", err)
	}
	if configured.Revision != 2 || configured.SMTP.Revision != 1 || configured.SMTP.Active || !configured.SMTP.RequiresTest || !configured.SMTP.ConfigurationValid {
		t.Fatalf("unexpected configured SMTP state: %#v", configured.SMTP)
	}
	if !configured.SMTP.Password.Configured || configured.SMTP.Password.Source != SettingSourceDatabase {
		t.Fatalf("unexpected redacted SMTP password metadata: %#v", configured.SMTP.Password)
	}
	var ciphertext string
	if err := db.QueryRowContext(ctx, `SELECT secret_ciphertext FROM system_setting_overrides WHERE setting_key='smtp.password'`).Scan(&ciphertext); err != nil {
		t.Fatalf("read SMTP ciphertext: %v", err)
	}
	if strings.Contains(ciphertext, password) || ciphertext == password {
		t.Fatal("SMTP password was not encrypted before persistence")
	}
	resolved, err := service.ResolveSMTP(ctx)
	if err != nil {
		t.Fatalf("resolve disabled SMTP: %v", err)
	}
	if resolved.Password != password || resolved.Enabled {
		t.Fatalf("unexpected resolved disabled SMTP: enabled=%v password_match=%v", resolved.Enabled, resolved.Password == password)
	}

	turnOn := true
	if _, err := service.UpdateSettings(ctx, "admin", configured.Revision, SettingsPatch{SMTP: &SMTPPatch{Enabled: &turnOn}}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("untested SMTP enable error=%v, want conflict", err)
	}
	failed, err := service.MarkSMTPTestFailed(ctx, "admin", configured.Revision, configured.SMTP.Revision)
	if err != nil {
		t.Fatalf("mark SMTP test failed: %v", err)
	}
	if failed.SMTP.TestStatus != SMTPTestStatusFailed || failed.SMTP.TestedRevision != nil || failed.SMTP.Active {
		t.Fatalf("unexpected failed SMTP state: %#v", failed.SMTP)
	}
	tested, err := service.MarkSMTPTested(ctx, "admin", failed.Revision, configured.SMTP.Revision)
	if err != nil {
		t.Fatalf("mark SMTP tested: %v", err)
	}
	if tested.Revision != 4 || tested.SMTP.TestStatus != SMTPTestStatusVerified || tested.SMTP.TestedRevision == nil || *tested.SMTP.TestedRevision != 1 || tested.SMTP.Active {
		t.Fatalf("unexpected tested SMTP state: %#v", tested.SMTP)
	}
	active, err := service.UpdateSettings(ctx, "admin", tested.Revision, SettingsPatch{SMTP: &SMTPPatch{Enabled: &turnOn}})
	if err != nil {
		t.Fatalf("enable tested SMTP: %v", err)
	}
	if !active.SMTP.Active {
		t.Fatalf("tested SMTP was not activated: %#v", active.SMTP)
	}
	resolved, err = service.ResolveSMTP(ctx)
	if err != nil || !resolved.Enabled || resolved.Password != password {
		t.Fatalf("resolved active SMTP enabled=%v password_match=%v err=%v", resolved.Enabled, resolved.Password == password, err)
	}
	wrongCipher, err := NewSMTPPasswordCipher(bytes.Repeat([]byte{0x99}, 32))
	if err != nil {
		t.Fatalf("create wrong SMTP password cipher: %v", err)
	}
	wrongKeyService, err := NewService(db, service.defaults, wrongCipher)
	if err != nil {
		t.Fatalf("create wrong-key system service: %v", err)
	}
	wrongKeySettings, err := wrongKeyService.GetSettings(ctx)
	if err != nil {
		t.Fatalf("read wrong-key SMTP settings: %v", err)
	}
	if wrongKeySettings.SMTP.ConfigurationValid || wrongKeySettings.SMTP.Active {
		t.Fatalf("wrong encryption key left SMTP usable: %#v", wrongKeySettings.SMTP)
	}
	if _, err := wrongKeyService.ResolveSMTP(ctx); err == nil {
		t.Fatal("wrong encryption key unexpectedly resolved SMTP password")
	}

	newHost := "smtp2.example.test"
	changed, err := service.UpdateSettings(ctx, "admin", active.Revision, SettingsPatch{SMTP: &SMTPPatch{Host: &newHost}})
	if err != nil {
		t.Fatalf("change tested SMTP: %v", err)
	}
	if changed.SMTP.Enabled.Value || changed.SMTP.Active || changed.SMTP.TestStatus != SMTPTestStatusUntested || changed.SMTP.TestedRevision != nil || changed.SMTP.Revision != 2 {
		t.Fatalf("changed SMTP was not safely disabled: %#v", changed.SMTP)
	}
	locallyTested, err := service.MarkSMTPTestedLocally(ctx, changed.Revision, changed.SMTP.Revision)
	if err != nil {
		t.Fatalf("mark SMTP tested from local administration: %v", err)
	}
	if locallyTested.SMTP.TestedRevision == nil || *locallyTested.SMTP.TestedRevision != changed.SMTP.Revision {
		t.Fatalf("local SMTP test did not persist exact revision: %#v", locallyTested.SMTP)
	}
}

func TestSMTPPasswordCipherUsesPurposeDerivedAuthenticatedEncryption(t *testing.T) {
	key := bytes.Repeat([]byte{0x42}, 32)
	cipher, err := NewSMTPPasswordCipher(key)
	if err != nil {
		t.Fatalf("new SMTP password cipher: %v", err)
	}
	envelope, err := cipher.Seal("smtp-password")
	if err != nil {
		t.Fatalf("seal SMTP password: %v", err)
	}
	opened, err := cipher.Open(envelope)
	if err != nil || opened != "smtp-password" {
		t.Fatalf("open SMTP password=%q err=%v", opened, err)
	}
	replacement := byte('A')
	if envelope[0] == replacement {
		replacement = 'B'
	}
	tampered := string(replacement) + envelope[1:]
	if _, err := cipher.Open(tampered); err == nil {
		t.Fatal("tampered SMTP password envelope unexpectedly opened")
	}
	if _, err := NewSMTPPasswordCipher([]byte("short")); err == nil {
		t.Fatal("short SMTP password key unexpectedly accepted")
	}
}

func TestDefaultsFromConfigTracksEnvironmentSources(t *testing.T) {
	for _, variable := range []string{
		"TEAMTALER_INSTANCE_NAME", "TEAMTALER_DEFAULT_CURRENCY", "TEAMTALER_MEDIA_UPLOAD_MAX_BYTES",
		"TEAMTALER_PUBLIC_JOIN_ENABLED", "TEAMTALER_MAINTENANCE_MODE", "TEAMTALER_MAINTENANCE_MESSAGE",
		"TEAMTALER_SMTP_HOST", "TEAMTALER_SMTP_PORT", "TEAMTALER_SMTP_TLS_MODE",
		"TEAMTALER_SMTP_USERNAME", "TEAMTALER_SMTP_PASSWORD", "TEAMTALER_SMTP_FROM_ADDRESS",
		"TEAMTALER_SMTP_FROM_NAME",
	} {
		t.Setenv(variable, "")
	}
	t.Setenv("TEAMTALER_INSTANCE_NAME", "Environment TeamTaler")
	t.Setenv("TEAMTALER_PUBLIC_JOIN_ENABLED", "false")
	t.Setenv("TEAMTALER_SMTP_HOST", "smtp.example.test")
	configuration := config.Config{
		MaxRequestBytes: 6 << 20,
		InstanceDefaults: config.InstanceDefaults{
			InstanceName:        "Environment TeamTaler",
			DefaultCurrency:     "EUR",
			MediaUploadMaxBytes: 5 << 20,
			PublicJoinEnabled:   false,
		},
		SMTP: config.SMTPConfig{Enabled: true, Host: "smtp.example.test"},
	}
	defaults := DefaultsFromConfig(configuration)
	if defaults.Sources[SettingInstanceName] != SettingSourceEnvironment || defaults.Sources[SettingPublicJoinEnabled] != SettingSourceEnvironment || defaults.Sources[SettingSMTPHost] != SettingSourceEnvironment || defaults.Sources[SettingSMTPEnabled] != SettingSourceEnvironment {
		t.Fatalf("unexpected environment sources: %#v", defaults.Sources)
	}
	if _, found := defaults.Sources[SettingDefaultCurrency]; found {
		t.Fatal("unset default currency unexpectedly marked as environment-backed")
	}
}

func TestDefaultsFromConfigProvidesSMTPSubmissionDefaults(t *testing.T) {
	defaults := DefaultsFromConfig(config.Config{})
	if defaults.SMTP.Enabled {
		t.Fatal("unconfigured SMTP defaults unexpectedly enabled delivery")
	}
	if defaults.SMTP.Port != config.DefaultSMTPPort || defaults.SMTP.TLSMode != SMTPTLSModeStartTLS {
		t.Fatalf("unexpected SMTP submission defaults: %#v", defaults.SMTP)
	}
}

func openSystemService(t *testing.T) (*sql.DB, Service) {
	t.Helper()
	db, err := storage.Open(context.Background(), filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open system test database: %v", err)
	}
	cipher, err := NewSMTPPasswordCipher(bytes.Repeat([]byte{0x31}, 32))
	if err != nil {
		db.Close()
		t.Fatalf("create SMTP password cipher: %v", err)
	}
	service, err := NewService(db, Defaults{
		InstanceName:        "Host TeamTaler",
		DefaultCurrency:     "EUR",
		MediaUploadMaxBytes: 5 << 20,
		PublicJoinEnabled:   true,
		MaxRequestBytes:     6 << 20,
		Sources:             map[SettingKey]SettingSource{SettingInstanceName: SettingSourceEnvironment},
	}, cipher)
	if err != nil {
		db.Close()
		t.Fatalf("create system service: %v", err)
	}
	return db, service
}

func insertSystemTestUser(t *testing.T, db *sql.DB, id, email string, active bool) {
	t.Helper()
	activeValue := 0
	if active {
		activeValue = 1
	}
	const now = "2026-08-15T12:00:00Z"
	if _, err := db.Exec(`INSERT INTO users(id,email,display_name,password_hash,active,created_at,updated_at)
		VALUES(?,?,?,'test-password-hash',?,?,?)`, id, email, id, activeValue, now, now); err != nil {
		t.Fatalf("insert system test user %q: %v", id, err)
	}
}
