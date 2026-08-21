// Package config loads and validates TeamTaler runtime configuration.
package config

import (
	"encoding/base64"
	"fmt"
	"net"
	"net/mail"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	// MinimumMediaUploadBytes is the smallest configurable raw media upload.
	MinimumMediaUploadBytes int64 = 1 << 20
	// MaximumMediaUploadBytes is the compiled safety ceiling for raw media uploads.
	MaximumMediaUploadBytes int64 = 25 << 20
	// MediaUploadUnitBytes is the only supported increment for raw media limits.
	MediaUploadUnitBytes int64 = 1 << 20
	// DefaultMediaUploadBytes preserves TeamTaler's original five MiB upload limit.
	DefaultMediaUploadBytes int64 = 5 << 20
	// MinimumAttachmentUploadBytes is the smallest configurable receipt upload.
	MinimumAttachmentUploadBytes int64 = 1 << 20
	// MaximumAttachmentUploadBytes is the compiled receipt-upload safety ceiling.
	MaximumAttachmentUploadBytes int64 = 50 << 20
	// DefaultAttachmentUploadBytes is the default immutable receipt limit.
	DefaultAttachmentUploadBytes int64 = 15 << 20
	// MultipartRequestReserve leaves room for multipart headers and boundaries.
	MultipartRequestReserve int64 = 1 << 20
	// DefaultSMTPPort is the standard submission port offered for new STARTTLS configurations.
	DefaultSMTPPort = 587
)

// SMTPTLSMode identifies the mandatory transport-security negotiation used for
// an SMTP connection. Supported values are SMTPTLSModeStartTLS and
// SMTPTLSModeTLS; no plaintext mode exists.
type SMTPTLSMode string

const (
	// SMTPTLSModeStartTLS upgrades an SMTP connection before authentication or
	// message data is transmitted.
	SMTPTLSModeStartTLS SMTPTLSMode = "starttls"
	// SMTPTLSModeTLS establishes TLS before the SMTP greeting is exchanged.
	SMTPTLSModeTLS SMTPTLSMode = "tls"
)

// SMTPConfig contains validated SMTP delivery settings. Enabled is false only
// when no TEAMTALER_SMTP_* variable is configured. Host, Port, Username,
// Password, and FromAddress are required together when Enabled is true;
// FromName is optional and TLSMode defaults to SMTPTLSModeStartTLS.
type SMTPConfig struct {
	// Enabled reports whether the complete SMTP environment block was supplied.
	Enabled bool
	// Host is the certificate-verified SMTP hostname or IP address without a port.
	Host string
	// Port is the TCP port used for the selected TLS mode.
	Port int
	// Username authenticates the application after TLS is established.
	Username string
	// Password authenticates the application after TLS is established.
	Password string
	// FromAddress is the ASCII envelope and message sender mailbox.
	FromAddress string
	// FromName is the optional human-readable sender name.
	FromName string
	// TLSMode selects required STARTTLS or implicit TLS negotiation.
	TLSMode SMTPTLSMode
	// AllowPrivateNetwork permits resolved private, loopback, link-local, or
	// otherwise non-public targets. It is immutable host trust configuration.
	AllowPrivateNetwork bool
	// AllowedPrivateHost preserves backward compatibility for one host-provided
	// SMTP relay without authorizing other runtime-configured private targets.
	AllowedPrivateHost string
	// AllowedPrivatePort restricts the host-provided private relay exception to
	// its configured TCP port.
	AllowedPrivatePort int
}

// WebPushConfig contains validated host defaults for standards-based Web Push.
// VAPIDPrivateKey is a raw base64url-encoded P-256 scalar and is never exposed
// through public APIs or logs. Subject is either an HTTPS origin or a mailto URL.
type WebPushConfig struct {
	// Enabled reports whether Web Push delivery is enabled by the host.
	Enabled bool
	// Subject identifies the VAPID operator to push services.
	Subject string
	// VAPIDPrivateKey contains the write-only signing key supplied by the host.
	VAPIDPrivateKey string
}

// InstanceDefaults contains mutable instance-setting defaults supplied by the
// process environment. Persisted settings may override these values without a
// restart, while clearing an override restores the corresponding value here.
type InstanceDefaults struct {
	// InstanceName is the operator-defined label shown on public and system pages.
	InstanceName string
	// DefaultCurrency is preselected when a system administrator creates a group.
	DefaultCurrency string
	// MediaUploadMaxBytes limits raw image input before decoding.
	MediaUploadMaxBytes int64
	// AttachmentUploadMaxBytes limits payment receipt input before normalization.
	AttachmentUploadMaxBytes int64
	// PublicJoinEnabled is the installation-wide public-registration kill switch.
	PublicJoinEnabled bool
	// MaintenanceMode blocks non-system mutations while preserving reads and login.
	MaintenanceMode bool
	// MaintenanceMessage is the optional public explanation shown during maintenance.
	MaintenanceMessage string
}

// Config contains validated, immutable process-level configuration.
// Construct it with Load rather than populating fields directly so URL,
// request-size, and proxy trust constraints are enforced.
type Config struct {
	ListenAddress     string
	DatabasePath      string
	DataDirectory     string
	WebDirectory      string
	PublicURL         *url.URL
	TrustedProxyCIDRs []netip.Prefix
	SecureCookies     bool
	SessionLifetime   time.Duration
	MaxRequestBytes   int64
	// InstanceDefaults supplies environment-backed defaults for mutable settings.
	InstanceDefaults InstanceDefaults
	// SMTP contains validated invitation-delivery configuration.
	SMTP SMTPConfig
	// SMTPTestRecipient optionally routes operator-triggered SMTP test messages
	// to one immutable mailbox instead of the authenticated administrator.
	SMTPTestRecipient string
	// EmailTokenKey is an optional decoded 32-byte AES key and is required when SMTP is enabled.
	EmailTokenKey []byte
	// WebPush contains validated Web Push host defaults.
	WebPush WebPushConfig
	// PushStorageKey is optional decoded 32-byte key material used exclusively
	// for Web Push configuration and subscription envelopes.
	PushStorageKey []byte
}

// Load reads TEAMTALER_* environment variables and applies secure local defaults.
// It takes no parameters and returns a complete Config. It returns an error for
// malformed URLs, proxy CIDRs, request limits, SMTP settings, or email token
// keys. Example: set
// TEAMTALER_PUBLIC_URL=https://teamtaler.example before calling Load.
func Load() (Config, error) {
	dataDir := env("TEAMTALER_DATA_DIR", "./data")
	databasePath := env("TEAMTALER_DATABASE_PATH", filepath.Join(dataDir, "teamtaler.db"))
	absoluteDataDir, err := filepath.Abs(dataDir)
	if err != nil {
		return Config{}, fmt.Errorf("resolve TEAMTALER_DATA_DIR: %w", err)
	}
	absoluteDatabasePath, err := filepath.Abs(databasePath)
	if err != nil {
		return Config{}, fmt.Errorf("resolve TEAMTALER_DATABASE_PATH: %w", err)
	}
	if filepath.Dir(absoluteDatabasePath) != absoluteDataDir {
		return Config{}, fmt.Errorf("TEAMTALER_DATABASE_PATH must be a direct child of TEAMTALER_DATA_DIR")
	}
	publicRaw := env("TEAMTALER_PUBLIC_URL", "http://127.0.0.1:8080")
	publicURL, err := url.ParseRequestURI(publicRaw)
	if err != nil || publicURL.Host == "" || (publicURL.Scheme != "http" && publicURL.Scheme != "https") || publicURL.User != nil || publicURL.RawQuery != "" || publicURL.Fragment != "" || (publicURL.Path != "" && publicURL.Path != "/") {
		return Config{}, fmt.Errorf("TEAMTALER_PUBLIC_URL must be an absolute root HTTP(S) URL without credentials, query, or fragment")
	}
	if publicURL.Scheme == "http" && !isLoopbackHost(publicURL.Hostname()) {
		return Config{}, fmt.Errorf("TEAMTALER_PUBLIC_URL must use HTTPS unless its host is loopback")
	}

	maxRequestBytes, err := strconv.ParseInt(env("TEAMTALER_MAX_REQUEST_BYTES", "6291456"), 10, 64)
	if err != nil || maxRequestBytes < 1024 {
		return Config{}, fmt.Errorf("TEAMTALER_MAX_REQUEST_BYTES must be at least 1024")
	}
	instanceDefaults, err := loadInstanceDefaults()
	if err != nil {
		return Config{}, err
	}

	trusted, err := parsePrefixes(os.Getenv("TEAMTALER_TRUSTED_PROXY_CIDRS"))
	if err != nil {
		return Config{}, err
	}
	smtpConfig, err := loadSMTPConfig()
	if err != nil {
		return Config{}, err
	}
	smtpTestRecipient, err := loadOptionalMailbox("TEAMTALER_SMTP_TEST_RECIPIENT")
	if err != nil {
		return Config{}, err
	}
	emailTokenKey, err := loadEmailTokenKey()
	if err != nil {
		return Config{}, err
	}
	if smtpConfig.Enabled && len(emailTokenKey) == 0 {
		return Config{}, fmt.Errorf("TEAMTALER_EMAIL_TOKEN_KEY is required when SMTP delivery is configured")
	}
	webPushConfig, err := loadWebPushConfig()
	if err != nil {
		return Config{}, err
	}
	pushStorageKey, err := loadStandardBase64Key("TEAMTALER_PUSH_STORAGE_KEY")
	if err != nil {
		return Config{}, err
	}
	if webPushConfig.Enabled && len(pushStorageKey) == 0 {
		return Config{}, fmt.Errorf("TEAMTALER_PUSH_STORAGE_KEY is required when Web Push delivery is enabled")
	}

	return Config{
		ListenAddress:     env("TEAMTALER_LISTEN", "127.0.0.1:8080"),
		DatabasePath:      databasePath,
		DataDirectory:     dataDir,
		WebDirectory:      env("TEAMTALER_WEB_DIR", "./web/dist"),
		PublicURL:         publicURL,
		TrustedProxyCIDRs: trusted,
		SecureCookies:     publicURL.Scheme == "https",
		SessionLifetime:   30 * 24 * time.Hour,
		MaxRequestBytes:   maxRequestBytes,
		InstanceDefaults:  instanceDefaults,
		SMTP:              smtpConfig,
		SMTPTestRecipient: smtpTestRecipient,
		EmailTokenKey:     emailTokenKey,
		WebPush:           webPushConfig,
		PushStorageKey:    pushStorageKey,
	}, nil
}

func loadInstanceDefaults() (InstanceDefaults, error) {
	instanceName := env("TEAMTALER_INSTANCE_NAME", "TeamTaler")
	if len(instanceName) > 120 || containsControlCharacter(instanceName) {
		return InstanceDefaults{}, fmt.Errorf("TEAMTALER_INSTANCE_NAME must contain 1 to 120 characters without control characters")
	}
	defaultCurrency := strings.ToUpper(env("TEAMTALER_DEFAULT_CURRENCY", "EUR"))
	if !isCurrencyCode(defaultCurrency) {
		return InstanceDefaults{}, fmt.Errorf("TEAMTALER_DEFAULT_CURRENCY must be a three-letter uppercase currency code")
	}
	mediaUploadMaxBytes, err := strconv.ParseInt(env("TEAMTALER_MEDIA_UPLOAD_MAX_BYTES", strconv.FormatInt(DefaultMediaUploadBytes, 10)), 10, 64)
	if err != nil || mediaUploadMaxBytes < MinimumMediaUploadBytes || mediaUploadMaxBytes > MaximumMediaUploadBytes || mediaUploadMaxBytes%MediaUploadUnitBytes != 0 {
		return InstanceDefaults{}, fmt.Errorf("TEAMTALER_MEDIA_UPLOAD_MAX_BYTES must be a whole MiB value between %d and %d", MinimumMediaUploadBytes, MaximumMediaUploadBytes)
	}
	attachmentUploadMaxBytes, err := strconv.ParseInt(env("TEAMTALER_ATTACHMENT_UPLOAD_MAX_BYTES", strconv.FormatInt(DefaultAttachmentUploadBytes, 10)), 10, 64)
	if err != nil || attachmentUploadMaxBytes < MinimumAttachmentUploadBytes || attachmentUploadMaxBytes > MaximumAttachmentUploadBytes || attachmentUploadMaxBytes%MediaUploadUnitBytes != 0 {
		return InstanceDefaults{}, fmt.Errorf("TEAMTALER_ATTACHMENT_UPLOAD_MAX_BYTES must be a whole MiB value between %d and %d", MinimumAttachmentUploadBytes, MaximumAttachmentUploadBytes)
	}
	publicJoinEnabled, err := parseBoolEnvironment("TEAMTALER_PUBLIC_JOIN_ENABLED", true)
	if err != nil {
		return InstanceDefaults{}, err
	}
	maintenanceMode, err := parseBoolEnvironment("TEAMTALER_MAINTENANCE_MODE", false)
	if err != nil {
		return InstanceDefaults{}, err
	}
	maintenanceMessage := strings.TrimSpace(os.Getenv("TEAMTALER_MAINTENANCE_MESSAGE"))
	if len(maintenanceMessage) > 240 || containsControlCharacter(maintenanceMessage) {
		return InstanceDefaults{}, fmt.Errorf("TEAMTALER_MAINTENANCE_MESSAGE must contain at most 240 characters without control characters")
	}
	return InstanceDefaults{
		InstanceName:             instanceName,
		DefaultCurrency:          defaultCurrency,
		MediaUploadMaxBytes:      mediaUploadMaxBytes,
		AttachmentUploadMaxBytes: attachmentUploadMaxBytes,
		PublicJoinEnabled:        publicJoinEnabled,
		MaintenanceMode:          maintenanceMode,
		MaintenanceMessage:       maintenanceMessage,
	}, nil
}

func parseBoolEnvironment(name string, fallback bool) (bool, error) {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv(name)))
	if raw == "" {
		return fallback, nil
	}
	if raw == "true" {
		return true, nil
	}
	if raw == "false" {
		return false, nil
	}
	return false, fmt.Errorf("%s must be true or false", name)
}

func isCurrencyCode(value string) bool {
	if len(value) != 3 {
		return false
	}
	for _, character := range value {
		if character < 'A' || character > 'Z' {
			return false
		}
	}
	return true
}

func loadEmailTokenKey() ([]byte, error) {
	return loadStandardBase64Key("TEAMTALER_EMAIL_TOKEN_KEY")
}

func loadStandardBase64Key(name string) ([]byte, error) {
	encoded := strings.TrimSpace(os.Getenv(name))
	if encoded == "" {
		return nil, nil
	}
	key, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(key) != 32 {
		return nil, fmt.Errorf("%s must be standard base64 encoding exactly 32 bytes", name)
	}
	return key, nil
}

func loadWebPushConfig() (WebPushConfig, error) {
	enabled, err := parseBoolEnvironment("TEAMTALER_WEB_PUSH_ENABLED", false)
	if err != nil {
		return WebPushConfig{}, err
	}
	subject := strings.TrimSpace(os.Getenv("TEAMTALER_WEB_PUSH_SUBJECT"))
	privateKey := strings.TrimSpace(os.Getenv("TEAMTALER_WEB_PUSH_VAPID_PRIVATE_KEY"))
	if enabled && subject == "" {
		return WebPushConfig{}, fmt.Errorf("TEAMTALER_WEB_PUSH_SUBJECT is required when Web Push delivery is enabled")
	}
	if enabled && privateKey == "" {
		return WebPushConfig{}, fmt.Errorf("TEAMTALER_WEB_PUSH_VAPID_PRIVATE_KEY is required when Web Push delivery is enabled")
	}
	if subject != "" {
		parsed, parseErr := url.ParseRequestURI(subject)
		validHTTPS := parseErr == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil && parsed.Fragment == ""
		validMailto := parseErr == nil && parsed.Scheme == "mailto" && parsed.Opaque != "" && isMailbox(parsed.Opaque)
		if !validHTTPS && !validMailto {
			return WebPushConfig{}, fmt.Errorf("TEAMTALER_WEB_PUSH_SUBJECT must be an HTTPS URL or a mailto URL with one ASCII mailbox")
		}
	}
	if privateKey != "" {
		decoded, decodeErr := base64.RawURLEncoding.Strict().DecodeString(privateKey)
		if decodeErr != nil || len(decoded) != 32 {
			return WebPushConfig{}, fmt.Errorf("TEAMTALER_WEB_PUSH_VAPID_PRIVATE_KEY must be unpadded base64url encoding exactly 32 bytes")
		}
	}
	return WebPushConfig{Enabled: enabled, Subject: subject, VAPIDPrivateKey: privateKey}, nil
}

func loadSMTPConfig() (SMTPConfig, error) {
	allowPrivateNetwork, err := parseBoolEnvironment("TEAMTALER_SMTP_ALLOW_PRIVATE_NETWORK", false)
	if err != nil {
		return SMTPConfig{}, err
	}
	variables := []string{
		"TEAMTALER_SMTP_HOST",
		"TEAMTALER_SMTP_PORT",
		"TEAMTALER_SMTP_USERNAME",
		"TEAMTALER_SMTP_PASSWORD",
		"TEAMTALER_SMTP_FROM_ADDRESS",
		"TEAMTALER_SMTP_FROM_NAME",
		"TEAMTALER_SMTP_TLS_MODE",
	}
	configured := false
	for _, name := range variables {
		if strings.TrimSpace(os.Getenv(name)) != "" {
			configured = true
			break
		}
	}
	if !configured {
		return SMTPConfig{
			Port:                DefaultSMTPPort,
			TLSMode:             SMTPTLSModeStartTLS,
			AllowPrivateNetwork: allowPrivateNetwork,
		}, nil
	}

	required := []string{
		"TEAMTALER_SMTP_HOST",
		"TEAMTALER_SMTP_PORT",
		"TEAMTALER_SMTP_USERNAME",
		"TEAMTALER_SMTP_PASSWORD",
		"TEAMTALER_SMTP_FROM_ADDRESS",
	}
	for _, name := range required {
		if strings.TrimSpace(os.Getenv(name)) == "" {
			return SMTPConfig{}, fmt.Errorf("%s is required when SMTP delivery is configured", name)
		}
	}

	rawHost := os.Getenv("TEAMTALER_SMTP_HOST")
	if containsControlCharacter(rawHost) {
		return SMTPConfig{}, fmt.Errorf("TEAMTALER_SMTP_HOST must not contain control characters")
	}
	host := strings.TrimSpace(rawHost)
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	}
	if host == "" || len(host) > 253 || strings.ContainsAny(host, "\x00\r\n\t /@") {
		return SMTPConfig{}, fmt.Errorf("TEAMTALER_SMTP_HOST must be a hostname or IP address without a scheme, path, or port")
	}
	if parsedHost, parsedPort, splitErr := net.SplitHostPort(host); splitErr == nil && parsedHost != "" && parsedPort != "" {
		return SMTPConfig{}, fmt.Errorf("TEAMTALER_SMTP_HOST must not include a port")
	}
	if strings.Contains(host, ":") && net.ParseIP(host) == nil {
		return SMTPConfig{}, fmt.Errorf("TEAMTALER_SMTP_HOST must be a valid hostname or IP address")
	}

	port, err := strconv.Atoi(strings.TrimSpace(os.Getenv("TEAMTALER_SMTP_PORT")))
	if err != nil || port < 1 || port > 65535 {
		return SMTPConfig{}, fmt.Errorf("TEAMTALER_SMTP_PORT must be an integer between 1 and 65535")
	}

	rawUsername := os.Getenv("TEAMTALER_SMTP_USERNAME")
	username := strings.TrimSpace(rawUsername)
	password := os.Getenv("TEAMTALER_SMTP_PASSWORD")
	if containsControlCharacter(rawUsername) || strings.ContainsRune(password, '\x00') {
		return SMTPConfig{}, fmt.Errorf("TEAMTALER_SMTP_USERNAME and TEAMTALER_SMTP_PASSWORD must not contain SMTP control characters")
	}

	rawFromAddress := os.Getenv("TEAMTALER_SMTP_FROM_ADDRESS")
	if containsControlCharacter(rawFromAddress) {
		return SMTPConfig{}, fmt.Errorf("TEAMTALER_SMTP_FROM_ADDRESS must not contain control characters")
	}
	fromAddress := strings.TrimSpace(rawFromAddress)
	if !isMailbox(fromAddress) {
		return SMTPConfig{}, fmt.Errorf("TEAMTALER_SMTP_FROM_ADDRESS must be one ASCII mailbox address without a display name")
	}
	rawFromName := os.Getenv("TEAMTALER_SMTP_FROM_NAME")
	if containsControlCharacter(rawFromName) {
		return SMTPConfig{}, fmt.Errorf("TEAMTALER_SMTP_FROM_NAME must contain at most 120 characters without control characters")
	}
	fromName := strings.TrimSpace(rawFromName)
	if len(fromName) > 120 {
		return SMTPConfig{}, fmt.Errorf("TEAMTALER_SMTP_FROM_NAME must contain at most 120 characters without control characters")
	}

	tlsMode := SMTPTLSMode(strings.ToLower(strings.TrimSpace(os.Getenv("TEAMTALER_SMTP_TLS_MODE"))))
	if tlsMode == "" {
		tlsMode = SMTPTLSModeStartTLS
	}
	if tlsMode != SMTPTLSModeStartTLS && tlsMode != SMTPTLSModeTLS {
		return SMTPConfig{}, fmt.Errorf("TEAMTALER_SMTP_TLS_MODE must be starttls or tls")
	}

	return SMTPConfig{
		Enabled:             true,
		Host:                host,
		Port:                port,
		Username:            username,
		Password:            password,
		FromAddress:         fromAddress,
		FromName:            fromName,
		TLSMode:             tlsMode,
		AllowPrivateNetwork: allowPrivateNetwork,
		AllowedPrivateHost:  host,
		AllowedPrivatePort:  port,
	}, nil
}

// loadOptionalMailbox reads one optional ASCII mailbox from the process
// environment. name identifies the variable. It returns an empty string when
// unset and an error when the value is not exactly one bare mailbox address.
func loadOptionalMailbox(name string) (string, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return "", nil
	}
	if containsControlCharacter(os.Getenv(name)) || !isMailbox(value) {
		return "", fmt.Errorf("%s must be one ASCII mailbox address without a display name", name)
	}
	return value, nil
}

func isMailbox(value string) bool {
	parsedAddress, err := mail.ParseAddress(value)
	return err == nil && len(value) <= 254 && parsedAddress.Name == "" && parsedAddress.Address == value && strings.Contains(value, "@") && isASCII(value)
}

func isASCII(value string) bool {
	for _, character := range value {
		if character > 127 {
			return false
		}
	}
	return true
}

func containsControlCharacter(value string) bool {
	for _, character := range value {
		if character < 32 || character == 127 {
			return true
		}
	}
	return false
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	address, err := netip.ParseAddr(host)
	return err == nil && address.IsLoopback()
}

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func parsePrefixes(raw string) ([]netip.Prefix, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var prefixes []netip.Prefix
	for _, value := range strings.Split(raw, ",") {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(value))
		if err != nil {
			return nil, fmt.Errorf("TEAMTALER_TRUSTED_PROXY_CIDRS: %w", err)
		}
		prefixes = append(prefixes, prefix)
	}
	return prefixes, nil
}
