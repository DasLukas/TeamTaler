// Package system owns instance-wide roles, runtime settings, and immutable
// audit records. Its authorization model is deliberately independent from
// group memberships and group-scoped role assignments.
package system

import "database/sql"

// Role identifies one instance-wide authorization role.
type Role string

const (
	// RoleSystemAdministrator permits access to instance administration. It is
	// assigned only through trusted local administration workflows.
	RoleSystemAdministrator Role = "SYSTEM_ADMINISTRATOR"
)

// SettingKey identifies one supported, persistable instance setting.
type SettingKey string

const (
	// SettingInstanceName controls the public instance display name.
	SettingInstanceName SettingKey = "instance.name"
	// SettingDefaultCurrency controls the currency assigned to new groups.
	SettingDefaultCurrency SettingKey = "instance.default_currency"
	// SettingTimeZone controls the installation-wide IANA scheduling time zone.
	SettingTimeZone SettingKey = "instance.timezone"
	// SettingMediaUploadMaxBytes controls the maximum accepted source-media size.
	SettingMediaUploadMaxBytes SettingKey = "media.upload_max_bytes"
	// SettingAttachmentUploadMaxBytes controls the maximum payment receipt size.
	SettingAttachmentUploadMaxBytes SettingKey = "attachment.upload_max_bytes"
	// SettingPublicJoinEnabled gates every group public-join link globally.
	SettingPublicJoinEnabled SettingKey = "access.public_join_enabled"
	// SettingMaintenanceEnabled controls instance-wide maintenance mode.
	SettingMaintenanceEnabled SettingKey = "maintenance.enabled"
	// SettingMaintenanceMessage is the short public maintenance explanation.
	SettingMaintenanceMessage SettingKey = "maintenance.message"
	// SettingSMTPEnabled controls runtime SMTP delivery.
	SettingSMTPEnabled SettingKey = "smtp.enabled"
	// SettingSMTPHost is the SMTP server host without scheme, path, or port.
	SettingSMTPHost SettingKey = "smtp.host"
	// SettingSMTPPort is the SMTP server TCP port.
	SettingSMTPPort SettingKey = "smtp.port"
	// SettingSMTPTLSMode controls mandatory SMTP transport security negotiation.
	SettingSMTPTLSMode SettingKey = "smtp.tls_mode"
	// SettingSMTPUsername is the SMTP authentication identity.
	SettingSMTPUsername SettingKey = "smtp.username"
	// SettingSMTPFromAddress is the SMTP envelope and message sender mailbox.
	SettingSMTPFromAddress SettingKey = "smtp.from_address"
	// SettingSMTPFromName is the optional human-readable sender name.
	SettingSMTPFromName SettingKey = "smtp.from_name"
	// SettingSMTPPassword is the write-only encrypted SMTP credential.
	SettingSMTPPassword SettingKey = "smtp.password"
	// SettingWebPushEnabled controls standards-based Web Push delivery.
	SettingWebPushEnabled SettingKey = "web_push.enabled"
	// SettingWebPushSubject identifies the operator in VAPID assertions.
	SettingWebPushSubject SettingKey = "web_push.subject"
	// SettingWebPushVAPIDPrivateKey is the write-only encrypted signing key.
	SettingWebPushVAPIDPrivateKey SettingKey = "web_push.vapid_private_key"
)

// AllSettingKeys returns every persistable setting in stable display order.
// The returned slice is a copy and may be modified by the caller.
func AllSettingKeys() []SettingKey {
	return append([]SettingKey(nil), allSettingKeys...)
}

var allSettingKeys = []SettingKey{
	SettingInstanceName,
	SettingDefaultCurrency,
	SettingTimeZone,
	SettingMediaUploadMaxBytes,
	SettingAttachmentUploadMaxBytes,
	SettingPublicJoinEnabled,
	SettingMaintenanceEnabled,
	SettingMaintenanceMessage,
	SettingSMTPEnabled,
	SettingSMTPHost,
	SettingSMTPPort,
	SettingSMTPTLSMode,
	SettingSMTPUsername,
	SettingSMTPFromAddress,
	SettingSMTPFromName,
	SettingSMTPPassword,
	SettingWebPushEnabled,
	SettingWebPushSubject,
	SettingWebPushVAPIDPrivateKey,
}

// SettingSource identifies the layer that supplies an effective value.
type SettingSource string

const (
	// SettingSourceCode means the compiled application default is effective.
	SettingSourceCode SettingSource = "CODE"
	// SettingSourceEnvironment means the host environment default is effective.
	SettingSourceEnvironment SettingSource = "ENVIRONMENT"
	// SettingSourceDatabase means a runtime database override is effective.
	SettingSourceDatabase SettingSource = "DATABASE"
)

// LegalDocumentKey identifies one public legal document managed by the
// instance operator.
type LegalDocumentKey string

const (
	// LegalDocumentImprint identifies the public operator imprint.
	LegalDocumentImprint LegalDocumentKey = "IMPRINT"
	// LegalDocumentPrivacyPolicy identifies the public privacy notice.
	LegalDocumentPrivacyPolicy LegalDocumentKey = "PRIVACY_POLICY"
)

// LegalDocumentSource identifies the layer supplying a legal document.
type LegalDocumentSource string

const (
	// LegalDocumentSourceCode means no host file or database override supplies
	// the document, so the built-in empty value is effective.
	LegalDocumentSourceCode LegalDocumentSource = "CODE"
	// LegalDocumentSourceFile means the current host file is effective.
	LegalDocumentSourceFile LegalDocumentSource = "FILE"
	// LegalDocumentSourceDatabase means an administrator override is effective.
	LegalDocumentSourceDatabase LegalDocumentSource = "DATABASE"
)

// LegalDocument is one effective administrator-facing legal document. Content
// is Markdown source; rendering remains responsible for rejecting raw HTML.
type LegalDocument struct {
	Content         string              `json:"content"`
	Source          LegalDocumentSource `json:"source"`
	Configured      bool                `json:"configured"`
	OverrideVersion int64               `json:"overrideVersion,omitempty"`
	UpdatedAt       string              `json:"updatedAt,omitempty"`
}

// LegalDocuments is the versioned administrator projection of every public
// legal document.
type LegalDocuments struct {
	Revision        int64         `json:"revision"`
	Imprint         LegalDocument `json:"imprint"`
	PrivacyPolicy   LegalDocument `json:"privacyPolicy"`
	UpdatedAt       string        `json:"updatedAt"`
	UpdatedByUserID *string       `json:"updatedByUserId,omitempty"`
}

// PublicLegalDocuments is the metadata-free projection exposed without an
// authenticated session.
type PublicLegalDocuments struct {
	Imprint       string `json:"imprint"`
	PrivacyPolicy string `json:"privacyPolicy"`
}

// LegalDocumentsPatch contains optional complete Markdown replacements.
type LegalDocumentsPatch struct {
	Imprint       *string `json:"imprint,omitempty"`
	PrivacyPolicy *string `json:"privacyPolicy,omitempty"`
}

// SMTPTLSMode identifies the required SMTP transport-security negotiation.
type SMTPTLSMode string

const (
	// SMTPTLSModeStartTLS upgrades the SMTP connection before authentication.
	SMTPTLSModeStartTLS SMTPTLSMode = "starttls"
	// SMTPTLSModeTLS establishes TLS before the SMTP greeting.
	SMTPTLSModeTLS SMTPTLSMode = "tls"
)

// SMTPTestStatus identifies the persisted outcome for the current database
// SMTP revision. Host-default configurations can be active without this state.
type SMTPTestStatus string

const (
	// SMTPTestStatusUntested means the current revision has no completed test.
	SMTPTestStatusUntested SMTPTestStatus = "UNTESTED"
	// SMTPTestStatusVerified means the exact current revision delivered a test.
	SMTPTestStatusVerified SMTPTestStatus = "VERIFIED"
	// SMTPTestStatusFailed means the latest test of the current revision failed.
	SMTPTestStatusFailed SMTPTestStatus = "FAILED"
)

// Setting contains one effective typed value and safe override metadata.
// OverrideVersion is zero and UpdatedAt is empty when no database override is
// present.
type Setting[T any] struct {
	Value           T             `json:"value"`
	Source          SettingSource `json:"source"`
	OverrideVersion int64         `json:"overrideVersion,omitempty"`
	UpdatedAt       string        `json:"updatedAt,omitempty"`
}

// SecretSetting reports safe secret metadata without exposing either plaintext
// or ciphertext.
type SecretSetting struct {
	Configured      bool          `json:"configured"`
	Source          SettingSource `json:"source"`
	OverrideVersion int64         `json:"overrideVersion,omitempty"`
	UpdatedAt       string        `json:"updatedAt,omitempty"`
}

// SMTPConfiguration is a complete effective delivery configuration used by
// trusted runtime integrations. Password is deliberately omitted from JSON.
type SMTPConfiguration struct {
	Enabled     bool        `json:"enabled"`
	Host        string      `json:"host"`
	Port        int         `json:"port"`
	TLSMode     SMTPTLSMode `json:"tlsMode"`
	Username    string      `json:"username"`
	Password    string      `json:"-"`
	FromAddress string      `json:"fromAddress"`
	FromName    string      `json:"fromName"`
	// AllowPrivateNetwork and AllowedPrivateHost are immutable host trust
	// controls and are never exposed through the settings API.
	AllowPrivateNetwork bool   `json:"-"`
	AllowedPrivateHost  string `json:"-"`
	AllowedPrivatePort  int    `json:"-"`
}

// SMTPSettings contains redacted effective SMTP values and verification state.
// Active is true only when delivery is enabled, complete, and either supplied
// wholly by trusted host defaults or verified at the current SMTP revision.
type SMTPSettings struct {
	Enabled            Setting[bool]        `json:"enabled"`
	Host               Setting[string]      `json:"host"`
	Port               Setting[int]         `json:"port"`
	TLSMode            Setting[SMTPTLSMode] `json:"tlsMode"`
	Username           Setting[string]      `json:"username"`
	Password           SecretSetting        `json:"password"`
	FromAddress        Setting[string]      `json:"fromAddress"`
	FromName           Setting[string]      `json:"fromName"`
	Revision           int64                `json:"revision"`
	TestedRevision     *int64               `json:"testedRevision,omitempty"`
	TestedAt           string               `json:"testedAt,omitempty"`
	TestStatus         SMTPTestStatus       `json:"testStatus"`
	RequiresTest       bool                 `json:"requiresTest"`
	ConfigurationValid bool                 `json:"configurationValid"`
	Active             bool                 `json:"active"`
}

// WebPushConfiguration is the trusted effective VAPID configuration used by
// delivery code. VAPIDPrivateKey is deliberately omitted from JSON.
type WebPushConfiguration struct {
	Enabled         bool   `json:"enabled"`
	Subject         string `json:"subject"`
	VAPIDPrivateKey string `json:"-"`
	PublicKey       string `json:"publicKey"`
	KeyID           string `json:"keyId"`
}

// WebPushSettings contains redacted effective Web Push values. Active is true
// only when delivery is enabled and the VAPID secret can be safely resolved.
type WebPushSettings struct {
	Enabled              Setting[bool]   `json:"enabled"`
	Subject              Setting[string] `json:"subject"`
	VAPIDPrivateKey      SecretSetting   `json:"vapidPrivateKey"`
	PublicKey            string          `json:"publicKey,omitempty"`
	KeyID                string          `json:"keyId,omitempty"`
	Revision             int64           `json:"revision"`
	StorageKeyConfigured bool            `json:"storageKeyConfigured"`
	ConfigurationValid   bool            `json:"configurationValid"`
	Active               bool            `json:"active"`
}

// Defaults contains the validated host-level values underneath database
// overrides. Sources may mark individual values as ENVIRONMENT; omitted entries
// are treated as CODE. MaxRequestBytes is retained for compatibility with
// embedded configurations; media endpoints derive their request limit from the
// live MediaUploadMaxBytes setting.
type Defaults struct {
	InstanceName             string
	DefaultCurrency          string
	TimeZone                 string
	MediaUploadMaxBytes      int64
	AttachmentUploadMaxBytes int64
	PublicJoinEnabled        bool
	MaintenanceMode          bool
	MaintenanceMessage       string
	SMTP                     SMTPConfiguration
	WebPush                  WebPushConfiguration
	MaxRequestBytes          int64
	Sources                  map[SettingKey]SettingSource
}

// Settings is one transactionally consistent effective runtime snapshot.
// Revision is the optimistic concurrency token required by mutation methods.
type Settings struct {
	Revision                       int64           `json:"revision"`
	InstanceName                   Setting[string] `json:"instanceName"`
	DefaultCurrency                Setting[string] `json:"defaultCurrency"`
	TimeZone                       Setting[string] `json:"timeZone"`
	MediaUploadMaxBytes            Setting[int64]  `json:"mediaUploadMaxBytes"`
	MediaUploadHardLimitBytes      int64           `json:"mediaUploadHardLimitBytes"`
	AttachmentUploadMaxBytes       Setting[int64]  `json:"attachmentUploadMaxBytes"`
	AttachmentUploadHardLimitBytes int64           `json:"attachmentUploadHardLimitBytes"`
	PublicJoinEnabled              Setting[bool]   `json:"publicJoinEnabled"`
	MaintenanceMode                Setting[bool]   `json:"maintenanceMode"`
	MaintenanceMessage             Setting[string] `json:"maintenanceMessage"`
	SMTP                           SMTPSettings    `json:"smtp"`
	WebPush                        WebPushSettings `json:"webPush"`
	UpdatedAt                      string          `json:"updatedAt"`
	UpdatedByUserID                *string         `json:"updatedByUserId,omitempty"`
}

// SMTPPatch contains optional SMTP overrides. Password is write-only: an empty
// password is rejected and callers reset it through ResetSettings.
type SMTPPatch struct {
	Enabled     *bool        `json:"enabled,omitempty"`
	Host        *string      `json:"host,omitempty"`
	Port        *int         `json:"port,omitempty"`
	TLSMode     *SMTPTLSMode `json:"tlsMode,omitempty"`
	Username    *string      `json:"username,omitempty"`
	Password    *string      `json:"password,omitempty"`
	FromAddress *string      `json:"fromAddress,omitempty"`
	FromName    *string      `json:"fromName,omitempty"`
}

// WebPushPatch contains optional Web Push overrides. VAPIDPrivateKey is
// write-only and callers remove it through ResetSettings.
type WebPushPatch struct {
	Enabled         *bool   `json:"enabled,omitempty"`
	Subject         *string `json:"subject,omitempty"`
	VAPIDPrivateKey *string `json:"vapidPrivateKey,omitempty"`
}

// SettingsPatch contains optional instance-setting overrides. Nil fields are
// unchanged; explicit zero values are validated and persisted.
type SettingsPatch struct {
	InstanceName             *string       `json:"instanceName,omitempty"`
	DefaultCurrency          *string       `json:"defaultCurrency,omitempty"`
	TimeZone                 *string       `json:"timeZone,omitempty"`
	MediaUploadMaxBytes      *int64        `json:"mediaUploadMaxBytes,omitempty"`
	AttachmentUploadMaxBytes *int64        `json:"attachmentUploadMaxBytes,omitempty"`
	PublicJoinEnabled        *bool         `json:"publicJoinEnabled,omitempty"`
	MaintenanceMode          *bool         `json:"maintenanceMode,omitempty"`
	MaintenanceMessage       *string       `json:"maintenanceMessage,omitempty"`
	SMTP                     *SMTPPatch    `json:"smtp,omitempty"`
	WebPush                  *WebPushPatch `json:"webPush,omitempty"`
}

// RoleAssignment describes one durable instance-role assignment and its
// account. Active reports account state; inactive accounts never authorize.
type RoleAssignment struct {
	UserID          string  `json:"userId"`
	Email           string  `json:"email"`
	DisplayName     string  `json:"displayName"`
	Active          bool    `json:"active"`
	Role            Role    `json:"role"`
	GrantedAt       string  `json:"grantedAt"`
	GrantedByUserID *string `json:"grantedByUserId,omitempty"`
}

// AuditEvent is an immutable instance-wide security or administration event.
type AuditEvent struct {
	ID               string         `json:"id"`
	ActorUserID      *string        `json:"actorUserId,omitempty"`
	ActorDisplayName string         `json:"actorDisplayName,omitempty"`
	Action           string         `json:"action"`
	ResourceType     string         `json:"resourceType"`
	ResourceID       *string        `json:"resourceId,omitempty"`
	Metadata         map[string]any `json:"metadata"`
	OccurredAt       string         `json:"occurredAt"`
}

// PasswordCipher authenticates SMTP passwords before durable storage. Seal
// returns an opaque envelope; Open returns plaintext only to trusted runtime
// integrations. Implementations must never expose secrets in errors.
type PasswordCipher interface {
	Seal(plaintext string) (string, error)
	Open(envelope string) (string, error)
}

// WebPushSecretCipher authenticates VAPID private keys before storage and
// exposes plaintext only to trusted runtime integrations.
type WebPushSecretCipher interface {
	SealVAPIDPrivateKey(string) (string, error)
	OpenVAPIDPrivateKey(string) (string, error)
}

// Service coordinates system-role, setting, and audit persistence. Construct it
// with NewService so defaults and immutable upload limits are validated.
type Service struct {
	db             *sql.DB
	defaults       Defaults
	passwordCipher PasswordCipher
	webPushCipher  WebPushSecretCipher
	legalFiles     map[LegalDocumentKey]string
}
