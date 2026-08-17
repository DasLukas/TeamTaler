package config

import (
	"bytes"
	"encoding/base64"
	"path/filepath"
	"strings"
	"testing"
)

var smtpEnvironmentVariables = []string{
	"TEAMTALER_SMTP_HOST",
	"TEAMTALER_SMTP_PORT",
	"TEAMTALER_SMTP_USERNAME",
	"TEAMTALER_SMTP_PASSWORD",
	"TEAMTALER_SMTP_FROM_ADDRESS",
	"TEAMTALER_SMTP_FROM_NAME",
	"TEAMTALER_SMTP_TLS_MODE",
	"TEAMTALER_SMTP_ALLOW_PRIVATE_NETWORK",
	"TEAMTALER_SMTP_TEST_RECIPIENT",
	"TEAMTALER_EMAIL_TOKEN_KEY",
}

func TestLoadRejectsPublicURLSubpathsAndCredentials(t *testing.T) {
	clearSMTPEnvironment(t)
	invalid := []string{
		"https://example.test/teamtaler",
		"https://user:password@example.test/",
		"https://example.test/?tenant=one",
		"https://example.test/#fragment",
		"http://teamtaler.example.test/",
		"http://192.0.2.10:8080/",
	}
	for _, value := range invalid {
		t.Run(value, func(t *testing.T) {
			t.Setenv("TEAMTALER_PUBLIC_URL", value)
			if _, err := Load(); err == nil {
				t.Fatalf("invalid public URL %q was accepted", value)
			}
		})
	}
}

func TestLoadAllowsHTTPOnlyForLoopback(t *testing.T) {
	clearSMTPEnvironment(t)
	for _, value := range []string{"http://localhost:8080/", "http://127.0.0.1:8080/", "http://[::1]:8080/"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("TEAMTALER_PUBLIC_URL", value)
			loaded, err := Load()
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if loaded.SecureCookies {
				t.Fatal("loopback HTTP unexpectedly enabled secure cookies")
			}
		})
	}
}

func TestLoadAcceptsRootPublicURL(t *testing.T) {
	clearSMTPEnvironment(t)
	t.Setenv("TEAMTALER_PUBLIC_URL", "https://teamtaler.example.test/")
	loaded, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !loaded.SecureCookies {
		t.Fatal("HTTPS public URL did not enable secure cookies")
	}
}

func TestLoadRequiresDatabaseDirectlyInsideDataDirectory(t *testing.T) {
	clearSMTPEnvironment(t)
	dataDirectory := t.TempDir()
	t.Setenv("TEAMTALER_DATA_DIR", dataDirectory)
	for _, path := range []string{filepath.Join(dataDirectory, "nested", "teamtaler.db"), filepath.Join(t.TempDir(), "teamtaler.db")} {
		t.Run(path, func(t *testing.T) {
			t.Setenv("TEAMTALER_DATABASE_PATH", path)
			if _, err := Load(); err == nil {
				t.Fatalf("database path %q outside direct data-directory children was accepted", path)
			}
		})
	}
	t.Setenv("TEAMTALER_DATABASE_PATH", filepath.Join(dataDirectory, "custom.sqlite"))
	if _, err := Load(); err != nil {
		t.Fatalf("direct child database path was rejected: %v", err)
	}
}

func TestLoadDisablesSMTPWhenUnconfigured(t *testing.T) {
	clearSMTPEnvironment(t)
	loaded, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.SMTP.Enabled {
		t.Fatal("SMTP was enabled without any SMTP environment variables")
	}
	if loaded.SMTP.Port != DefaultSMTPPort || loaded.SMTP.TLSMode != SMTPTLSModeStartTLS {
		t.Fatalf("unexpected disabled SMTP defaults: %#v", loaded.SMTP)
	}
}

func TestLoadAcceptsCompleteSMTPConfigurationWithSecureDefaults(t *testing.T) {
	clearSMTPEnvironment(t)
	setCompleteSMTPEnvironment(t)
	t.Setenv("TEAMTALER_SMTP_FROM_NAME", "TeamTaler Notifications")

	loaded, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !loaded.SMTP.Enabled {
		t.Fatal("complete SMTP configuration was not enabled")
	}
	if loaded.SMTP.Host != "smtp.example.test" || loaded.SMTP.Port != 587 {
		t.Fatalf("unexpected SMTP endpoint: %s:%d", loaded.SMTP.Host, loaded.SMTP.Port)
	}
	if loaded.SMTP.Username != "mailer@example.test" || loaded.SMTP.Password != "smtp-secret" {
		t.Fatal("SMTP credentials were not loaded")
	}
	if loaded.SMTP.FromAddress != "teamtaler@example.test" || loaded.SMTP.FromName != "TeamTaler Notifications" {
		t.Fatalf("unexpected SMTP sender: address=%q name=%q", loaded.SMTP.FromAddress, loaded.SMTP.FromName)
	}
	if loaded.SMTP.TLSMode != SMTPTLSModeStartTLS {
		t.Fatalf("SMTP TLS mode = %q, want %q", loaded.SMTP.TLSMode, SMTPTLSModeStartTLS)
	}
	if loaded.SMTP.AllowPrivateNetwork || loaded.SMTP.AllowedPrivateHost != loaded.SMTP.Host || loaded.SMTP.AllowedPrivatePort != loaded.SMTP.Port {
		t.Fatalf("unexpected SMTP private-network policy: %#v", loaded.SMTP)
	}
	if !bytes.Equal(loaded.EmailTokenKey, bytes.Repeat([]byte{0x5a}, 32)) {
		t.Fatal("email token key was not decoded")
	}
}

func TestLoadValidatesOptionalSMTPTestRecipient(t *testing.T) {
	clearSMTPEnvironment(t)
	t.Setenv("TEAMTALER_SMTP_TEST_RECIPIENT", "delivery@example.test")
	loaded, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.SMTPTestRecipient != "delivery@example.test" {
		t.Fatalf("SMTP test recipient=%q, want delivery@example.test", loaded.SMTPTestRecipient)
	}

	t.Setenv("TEAMTALER_SMTP_TEST_RECIPIENT", "Delivery <delivery@example.test>")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "TEAMTALER_SMTP_TEST_RECIPIENT") {
		t.Fatalf("invalid SMTP test recipient error=%v", err)
	}
}

func TestLoadAcceptsImplicitSMTPTransportTLS(t *testing.T) {
	clearSMTPEnvironment(t)
	setCompleteSMTPEnvironment(t)
	t.Setenv("TEAMTALER_SMTP_PORT", "465")
	t.Setenv("TEAMTALER_SMTP_TLS_MODE", "TLS")

	loaded, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.SMTP.TLSMode != SMTPTLSModeTLS {
		t.Fatalf("SMTP TLS mode = %q, want %q", loaded.SMTP.TLSMode, SMTPTLSModeTLS)
	}
}

func TestLoadRequiresExplicitBooleanForPrivateSMTPNetworks(t *testing.T) {
	clearSMTPEnvironment(t)
	setCompleteSMTPEnvironment(t)
	t.Setenv("TEAMTALER_SMTP_ALLOW_PRIVATE_NETWORK", "true")
	loaded, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !loaded.SMTP.AllowPrivateNetwork {
		t.Fatal("explicit private SMTP network policy was not enabled")
	}
}

func TestLoadRejectsPartialSMTPConfiguration(t *testing.T) {
	required := []string{
		"TEAMTALER_SMTP_HOST",
		"TEAMTALER_SMTP_PORT",
		"TEAMTALER_SMTP_USERNAME",
		"TEAMTALER_SMTP_PASSWORD",
		"TEAMTALER_SMTP_FROM_ADDRESS",
		"TEAMTALER_EMAIL_TOKEN_KEY",
	}
	for _, missing := range required {
		t.Run(missing, func(t *testing.T) {
			clearSMTPEnvironment(t)
			setCompleteSMTPEnvironment(t)
			t.Setenv(missing, "")
			_, err := Load()
			if err == nil || !strings.Contains(err.Error(), missing) {
				t.Fatalf("missing %s error = %v", missing, err)
			}
		})
	}
}

func TestLoadRejectsUnsafeOrMalformedSMTPConfiguration(t *testing.T) {
	tests := []struct {
		name     string
		variable string
		value    string
	}{
		{name: "plaintext mode", variable: "TEAMTALER_SMTP_TLS_MODE", value: "plain"},
		{name: "unsupported mode", variable: "TEAMTALER_SMTP_TLS_MODE", value: "none"},
		{name: "invalid port", variable: "TEAMTALER_SMTP_PORT", value: "70000"},
		{name: "host includes scheme", variable: "TEAMTALER_SMTP_HOST", value: "smtp://example.test"},
		{name: "host includes port", variable: "TEAMTALER_SMTP_HOST", value: "smtp.example.test:587"},
		{name: "sender display form", variable: "TEAMTALER_SMTP_FROM_ADDRESS", value: "TeamTaler <teamtaler@example.test>"},
		{name: "sender header injection", variable: "TEAMTALER_SMTP_FROM_NAME", value: "TeamTaler\r\nBcc: attacker@example.test"},
		{name: "private network boolean", variable: "TEAMTALER_SMTP_ALLOW_PRIVATE_NETWORK", value: "yes"},
		{name: "malformed token key", variable: "TEAMTALER_EMAIL_TOKEN_KEY", value: "not-base64"},
		{name: "short token key", variable: "TEAMTALER_EMAIL_TOKEN_KEY", value: base64.StdEncoding.EncodeToString(make([]byte, 16))},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			clearSMTPEnvironment(t)
			setCompleteSMTPEnvironment(t)
			t.Setenv(test.variable, test.value)
			if _, err := Load(); err == nil {
				t.Fatalf("unsafe SMTP value %q for %s was accepted", test.value, test.variable)
			}
		})
	}
}

func TestLoadAcceptsOptionalEmailTokenKeyWithoutSMTP(t *testing.T) {
	clearSMTPEnvironment(t)
	expected := bytes.Repeat([]byte{0xa5}, 32)
	t.Setenv("TEAMTALER_EMAIL_TOKEN_KEY", base64.StdEncoding.EncodeToString(expected))

	loaded, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.SMTP.Enabled {
		t.Fatal("email token key alone unexpectedly enabled SMTP")
	}
	if !bytes.Equal(loaded.EmailTokenKey, expected) {
		t.Fatal("optional email token key was not decoded")
	}
}

func TestLoadReadsMutableInstanceDefaults(t *testing.T) {
	clearSMTPEnvironment(t)
	t.Setenv("TEAMTALER_MAX_REQUEST_BYTES", "12582912")
	t.Setenv("TEAMTALER_INSTANCE_NAME", "Example TeamTaler")
	t.Setenv("TEAMTALER_DEFAULT_CURRENCY", "usd")
	t.Setenv("TEAMTALER_MEDIA_UPLOAD_MAX_BYTES", "10485760")
	t.Setenv("TEAMTALER_PUBLIC_JOIN_ENABLED", "false")
	t.Setenv("TEAMTALER_MAINTENANCE_MODE", "true")
	t.Setenv("TEAMTALER_MAINTENANCE_MESSAGE", "Scheduled maintenance")

	loaded, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := InstanceDefaults{
		InstanceName:        "Example TeamTaler",
		DefaultCurrency:     "USD",
		MediaUploadMaxBytes: 10 << 20,
		PublicJoinEnabled:   false,
		MaintenanceMode:     true,
		MaintenanceMessage:  "Scheduled maintenance",
	}
	if loaded.InstanceDefaults != want {
		t.Fatalf("instance defaults = %#v, want %#v", loaded.InstanceDefaults, want)
	}
}

func TestLoadRejectsUnsafeMutableInstanceDefaults(t *testing.T) {
	clearSMTPEnvironment(t)
	tests := []struct {
		name     string
		variable string
		value    string
	}{
		{name: "instance controls", variable: "TEAMTALER_INSTANCE_NAME", value: "Unsafe\nName"},
		{name: "currency", variable: "TEAMTALER_DEFAULT_CURRENCY", value: "EURO"},
		{name: "media too small", variable: "TEAMTALER_MEDIA_UPLOAD_MAX_BYTES", value: "1024"},
		{name: "media fractional MiB", variable: "TEAMTALER_MEDIA_UPLOAD_MAX_BYTES", value: "1310720"},
		{name: "public join boolean", variable: "TEAMTALER_PUBLIC_JOIN_ENABLED", value: "yes"},
		{name: "maintenance boolean", variable: "TEAMTALER_MAINTENANCE_MODE", value: "1"},
		{name: "maintenance controls", variable: "TEAMTALER_MAINTENANCE_MESSAGE", value: "Unsafe\rMessage"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv(test.variable, test.value)
			if _, err := Load(); err == nil {
				t.Fatalf("unsafe %s value %q was accepted", test.variable, test.value)
			}
		})
	}
}

func TestLoadAllowsMediaDefaultAboveGeneralRequestLimit(t *testing.T) {
	clearSMTPEnvironment(t)
	t.Setenv("TEAMTALER_MAX_REQUEST_BYTES", "5242880")
	t.Setenv("TEAMTALER_MEDIA_UPLOAD_MAX_BYTES", "26214400")
	loaded, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.InstanceDefaults.MediaUploadMaxBytes != MaximumMediaUploadBytes {
		t.Fatalf("media default = %d, want %d", loaded.InstanceDefaults.MediaUploadMaxBytes, MaximumMediaUploadBytes)
	}
}

func clearSMTPEnvironment(t *testing.T) {
	t.Helper()
	for _, name := range smtpEnvironmentVariables {
		t.Setenv(name, "")
	}
}

func setCompleteSMTPEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv("TEAMTALER_SMTP_HOST", "smtp.example.test")
	t.Setenv("TEAMTALER_SMTP_PORT", "587")
	t.Setenv("TEAMTALER_SMTP_USERNAME", "mailer@example.test")
	t.Setenv("TEAMTALER_SMTP_PASSWORD", "smtp-secret")
	t.Setenv("TEAMTALER_SMTP_FROM_ADDRESS", "teamtaler@example.test")
	t.Setenv("TEAMTALER_EMAIL_TOKEN_KEY", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x5a}, 32)))
}
