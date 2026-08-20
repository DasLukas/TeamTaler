package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/catalog"
	"github.com/DasLukas/TeamTaler/internal/config"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
	systemadmin "github.com/DasLukas/TeamTaler/internal/system"
)

func TestSystemRoutesUseLiveGlobalAuthorizationAndDelegatedGroupCreation(t *testing.T) {
	fixture := newSystemHTTPFixture(t)
	member := fixture.createAccount(t, "member@example.test", "Member", "member-password-long-enough")
	if _, err := (groups.Service{DB: fixture.db}).Create(context.Background(), member.Principal, "Member Group", "EUR"); err != nil {
		t.Fatalf("create group-admin fixture: %v", err)
	}
	groupFreeAdministrator := fixture.createAccount(t, "system-only@example.test", "System Only", "system-password-long-enough")
	if _, err := fixture.system.GrantAdministrator(context.Background(), groupFreeAdministrator.Principal.UserID, fixture.bootstrap.Principal.UserID); err != nil {
		t.Fatalf("grant system administrator: %v", err)
	}

	response := fixture.serve(groupFreeAdministrator, http.MethodGet, "/api/v1/session", "", "")
	if response.Code != http.StatusOK {
		t.Fatalf("group-free session status=%d body=%s", response.Code, response.Body.String())
	}
	var sessionPayload struct {
		Groups        []json.RawMessage  `json:"groups"`
		ActiveGroupID *string            `json:"activeGroupId"`
		SystemRoles   []systemadmin.Role `json:"systemRoles"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &sessionPayload); err != nil {
		t.Fatalf("decode group-free session: %v", err)
	}
	if len(sessionPayload.Groups) != 0 || sessionPayload.ActiveGroupID != nil || len(sessionPayload.SystemRoles) != 1 || sessionPayload.SystemRoles[0] != systemadmin.RoleSystemAdministrator {
		t.Fatalf("unexpected group-free session: %#v", sessionPayload)
	}

	response = fixture.serve(member, http.MethodGet, "/api/v1/system/settings", "", "")
	if response.Code != http.StatusForbidden {
		t.Fatalf("group administrator system-settings status=%d body=%s, want 403", response.Code, response.Body.String())
	}
	response = fixture.serve(groupFreeAdministrator, http.MethodGet, "/api/v1/system/settings", "", "")
	if response.Code != http.StatusOK || response.Header().Get("ETag") == "" {
		t.Fatalf("system-only settings status=%d ETag=%q body=%s", response.Code, response.Header().Get("ETag"), response.Body.String())
	}

	provisioningBody := `{"name":"Provisioning Group","currency":"EUR","initialAdministratorEmail":"new-account@example.test"}`
	response = fixture.serve(groupFreeAdministrator, http.MethodPost, "/api/v1/system/groups", provisioningBody, "")
	if response.Code != http.StatusCreated {
		t.Fatalf("manual group provisioning status=%d body=%s, want 201", response.Code, response.Body.String())
	}
	var provisioningResult struct {
		Group               systemadmin.ManagedGroup `json:"group"`
		AcceptURL           string                   `json:"acceptUrl"`
		EmailDeliveryStatus string                   `json:"emailDeliveryStatus"`
		ExpiresAt           string                   `json:"expiresAt"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &provisioningResult); err != nil {
		t.Fatalf("decode manual provisioning result: %v", err)
	}
	if provisioningResult.Group.Status != systemadmin.GroupStatusProvisioning || provisioningResult.EmailDeliveryStatus != "NOT_REQUESTED" || !strings.HasPrefix(provisioningResult.AcceptURL, fixture.baseURL+"/invite#token=") || provisioningResult.ExpiresAt == "" {
		t.Fatalf("manual provisioning result=%#v", provisioningResult)
	}
	if _, err := time.Parse(time.RFC3339, provisioningResult.ExpiresAt); err != nil {
		t.Fatalf("parse provisioning expiry %q: %v", provisioningResult.ExpiresAt, err)
	}
	parsedInvitationURL, err := url.Parse(provisioningResult.AcceptURL)
	if err != nil {
		t.Fatalf("parse manual provisioning URL: %v", err)
	}
	invitationFragment, err := url.ParseQuery(parsedInvitationURL.Fragment)
	if err != nil {
		t.Fatalf("parse manual provisioning fragment: %v", err)
	}
	if _, err := fixture.auth.PreviewInvitation(context.Background(), invitationFragment.Get("token")); err != nil {
		t.Fatalf("preview manual provisioning invitation: %v", err)
	}
	var provisioningOutboxCount int
	if err := fixture.db.QueryRowContext(context.Background(), `SELECT count(*) FROM invitation_email_outbox WHERE group_id=?`, provisioningResult.Group.ID).Scan(&provisioningOutboxCount); err != nil || provisioningOutboxCount != 0 {
		t.Fatalf("manual provisioning outbox count=%d err=%v", provisioningOutboxCount, err)
	}

	groupBody := `{"name":"Delegated Group","currency":"EUR","initialAdministratorEmail":"member@example.test"}`
	response = fixture.serve(groupFreeAdministrator, http.MethodPost, "/api/v1/groups", groupBody, "")
	if response.Code != http.StatusCreated {
		t.Fatalf("legacy group alias status=%d body=%s", response.Code, response.Body.String())
	}
	var delegatedResult struct {
		Group systemadmin.ManagedGroup `json:"group"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &delegatedResult); err != nil {
		t.Fatalf("decode delegated group: %v", err)
	}
	created := delegatedResult.Group
	var targetMemberships, actorMemberships int
	if err := fixture.db.QueryRowContext(context.Background(), `SELECT count(*) FROM memberships WHERE group_id=? AND user_id=?`, created.ID, member.Principal.UserID).Scan(&targetMemberships); err != nil {
		t.Fatalf("count delegated administrator membership: %v", err)
	}
	if err := fixture.db.QueryRowContext(context.Background(), `SELECT count(*) FROM memberships WHERE group_id=? AND user_id=?`, created.ID, groupFreeAdministrator.Principal.UserID).Scan(&actorMemberships); err != nil {
		t.Fatalf("count acting administrator membership: %v", err)
	}
	if targetMemberships != 1 || actorMemberships != 0 {
		t.Fatalf("delegated memberships target=%d actor=%d", targetMemberships, actorMemberships)
	}
	logoKey := strings.Repeat("a", 64) + ".png"
	logoBody := []byte("managed-group-logo")
	if err := os.MkdirAll(filepath.Join(fixture.dataDirectory, "images"), 0o750); err != nil {
		t.Fatalf("create managed logo directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(fixture.dataDirectory, "images", logoKey), logoBody, 0o640); err != nil {
		t.Fatalf("write managed group logo: %v", err)
	}
	if _, err := fixture.db.ExecContext(context.Background(), `UPDATE groups SET logo_key=? WHERE id=?`, logoKey, created.ID); err != nil {
		t.Fatalf("attach managed group logo: %v", err)
	}
	response = fixture.serve(groupFreeAdministrator, http.MethodGet, "/api/v1/system/groups", "", "")
	if response.Code != http.StatusOK || !bytes.Contains(response.Body.Bytes(), []byte(`"logoUrl":"/api/v1/system/groups/`+created.ID+`/logo"`)) {
		t.Fatalf("managed group list logo status=%d body=%s", response.Code, response.Body.String())
	}
	response = fixture.serve(groupFreeAdministrator, http.MethodGet, "/api/v1/system/groups/"+created.ID+"/logo", "", "")
	if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), logoBody) || response.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("managed group logo status=%d type=%q body=%q", response.Code, response.Header().Get("Content-Type"), response.Body.Bytes())
	}
	response = fixture.serve(member, http.MethodGet, "/api/v1/system/groups/"+created.ID+"/logo", "", "")
	if response.Code != http.StatusForbidden {
		t.Fatalf("non-system managed logo status=%d body=%s, want 403", response.Code, response.Body.String())
	}

	if err := fixture.system.RevokeAdministrator(context.Background(), groupFreeAdministrator.Principal.UserID, fixture.bootstrap.Principal.UserID); err != nil {
		t.Fatalf("revoke system administrator: %v", err)
	}
	response = fixture.serve(groupFreeAdministrator, http.MethodGet, "/api/v1/system/settings", "", "")
	if response.Code != http.StatusForbidden {
		t.Fatalf("revoked session status=%d body=%s, want live 403", response.Code, response.Body.String())
	}
}

func TestRuntimeSystemSettingsAndMaintenanceGate(t *testing.T) {
	fixture := newSystemHTTPFixture(t)
	member := fixture.createAccount(t, "reader@example.test", "Reader", "reader-password-long-enough")

	settingsResponse := fixture.serve(fixture.bootstrap, http.MethodGet, "/api/v1/system/settings", "", "")
	if settingsResponse.Code != http.StatusOK {
		t.Fatalf("get settings status=%d body=%s", settingsResponse.Code, settingsResponse.Body.String())
	}
	etag := settingsResponse.Header().Get("ETag")
	settingsResponse = fixture.serve(fixture.bootstrap, http.MethodPatch, "/api/v1/system/settings", `{"instanceName":"Managed TeamTaler","maintenanceMode":true}`, etag)
	if settingsResponse.Code != http.StatusOK {
		t.Fatalf("enable maintenance status=%d body=%s", settingsResponse.Code, settingsResponse.Body.String())
	}

	capabilities := fixture.serve(auth.Session{}, http.MethodGet, "/api/v1/instance/capabilities", "", "")
	if capabilities.Code != http.StatusOK || !bytes.Contains(capabilities.Body.Bytes(), []byte(`"instanceName":"Managed TeamTaler"`)) || !bytes.Contains(capabilities.Body.Bytes(), []byte(`"maintenanceMode":true`)) {
		t.Fatalf("capabilities status=%d body=%s", capabilities.Code, capabilities.Body.String())
	}

	blocked := fixture.serve(member, http.MethodPatch, "/api/v1/me/profile", `{"displayName":"Blocked Change"}`, "")
	if blocked.Code != http.StatusServiceUnavailable {
		t.Fatalf("maintenance mutation status=%d body=%s, want 503", blocked.Code, blocked.Body.String())
	}
	read := fixture.serve(member, http.MethodGet, "/api/v1/session", "", "")
	if read.Code != http.StatusOK {
		t.Fatalf("maintenance read status=%d body=%s", read.Code, read.Body.String())
	}

	etag = settingsResponse.Header().Get("ETag")
	allowed := fixture.serve(fixture.bootstrap, http.MethodPatch, "/api/v1/system/settings", `{"maintenanceMessage":"Scheduled work"}`, etag)
	if allowed.Code != http.StatusOK {
		t.Fatalf("maintenance system mutation status=%d body=%s", allowed.Code, allowed.Body.String())
	}
	login := fixture.serve(auth.Session{}, http.MethodPost, "/api/v1/auth/login", `{"email":"reader@example.test","password":"reader-password-long-enough"}`, "")
	if login.Code != http.StatusOK {
		t.Fatalf("maintenance login status=%d body=%s", login.Code, login.Body.String())
	}
}

func TestSystemSettingsMutationsRejectEmptyAndCrossSectionPayloads(t *testing.T) {
	fixture := newSystemHTTPFixture(t)
	settingsResponse := fixture.serve(fixture.bootstrap, http.MethodGet, "/api/v1/system/settings", "", "")
	if settingsResponse.Code != http.StatusOK {
		t.Fatalf("get settings status=%d body=%s", settingsResponse.Code, settingsResponse.Body.String())
	}
	etag := settingsResponse.Header().Get("ETag")
	tests := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{name: "empty general patch", method: http.MethodPatch, path: "/api/v1/system/settings", body: `{}`},
		{name: "SMTP in general patch", method: http.MethodPatch, path: "/api/v1/system/settings", body: `{"smtp":{"host":"smtp.example.test"}}`},
		{name: "empty reset", method: http.MethodPost, path: "/api/v1/system/settings/reset", body: `{"keys":[]}`},
		{name: "empty SMTP patch", method: http.MethodPut, path: "/api/v1/system/settings/smtp", body: `{}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := fixture.serve(fixture.bootstrap, test.method, test.path, test.body, etag)
			if response.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status=%d body=%s, want 422", response.Code, response.Body.String())
			}
		})
	}
}

func TestConfiguredMediaLimitReturnsPayloadTooLargeForEveryImageUpload(t *testing.T) {
	fixture := newSystemHTTPFixture(t)
	ctx := context.Background()
	settings, err := fixture.system.GetSettings(ctx)
	if err != nil {
		t.Fatalf("get settings: %v", err)
	}
	limit := systemadmin.MinimumMediaUploadBytes
	if _, err := fixture.system.UpdateSettings(ctx, fixture.bootstrap.Principal.UserID, settings.Revision, systemadmin.SettingsPatch{MediaUploadMaxBytes: &limit}); err != nil {
		t.Fatalf("set media limit: %v", err)
	}
	groupItems, err := (groups.Service{DB: fixture.db}).List(ctx, fixture.bootstrap.Principal.UserID)
	if err != nil || len(groupItems) != 1 {
		t.Fatalf("list bootstrap group items=%d err=%v", len(groupItems), err)
	}
	membership := groupItems[0].Membership
	now := platform.Timestamp(platform.Now())
	if _, err := fixture.db.ExecContext(ctx, `INSERT INTO membership_role_assignments(group_id,membership_id,role_id,version,assigned_at,assigned_by) VALUES(?,?,?,1,?,?)`, membership.GroupID, membership.ID, authorization.TemplateRoleID(membership.GroupID, domain.RoleTemplateCatalog), now, fixture.bootstrap.Principal.UserID); err != nil {
		t.Fatalf("grant catalog management: %v", err)
	}
	catalogService := catalog.Service{DB: fixture.db}
	category, err := catalogService.CreateCategory(ctx, fixture.bootstrap.Principal, membership, catalog.CreateCategoryInput{Name: "Images", Icon: domain.CategoryIconDrink})
	if err != nil {
		t.Fatalf("create category: %v", err)
	}
	price := int64(100)
	product, err := catalogService.CreateProduct(ctx, fixture.bootstrap.Principal, membership, "media-limit-product", category.ID, catalog.CreateProductInput{Name: "Image product", PriceMinor: &price})
	if err != nil {
		t.Fatalf("create product: %v", err)
	}
	tests := []struct {
		name string
		path string
	}{
		{name: "avatar", path: "/api/v1/me/avatar"},
		{name: "group logo", path: "/api/v1/groups/" + membership.GroupID + "/logo"},
		{name: "product image", path: "/api/v1/groups/" + membership.GroupID + "/products/" + product.ID + "/image"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := fixture.serveMultipart(fixture.bootstrap, test.path, limit+1)
			if response.Code != http.StatusRequestEntityTooLarge {
				t.Fatalf("status=%d body=%s, want 413", response.Code, response.Body.String())
			}
		})
	}
}

func TestFailedSMTPTestPersistsRedactedRevisionStatus(t *testing.T) {
	fixture := newSystemHTTPFixture(t)
	settingsResponse := fixture.serve(fixture.bootstrap, http.MethodGet, "/api/v1/system/settings", "", "")
	if settingsResponse.Code != http.StatusOK {
		t.Fatalf("get settings status=%d body=%s", settingsResponse.Code, settingsResponse.Body.String())
	}
	configured := fixture.serve(fixture.bootstrap, http.MethodPut, "/api/v1/system/settings/smtp", `{
		"enabled":false,"host":"127.0.0.1","port":1,"tlsMode":"tls",
		"username":"mailer","password":"significant SMTP secret ",
		"fromAddress":"teamtaler@example.test","fromName":""
	}`, settingsResponse.Header().Get("ETag"))
	if configured.Code != http.StatusOK {
		t.Fatalf("configure SMTP status=%d body=%s", configured.Code, configured.Body.String())
	}
	tested := fixture.serve(fixture.bootstrap, http.MethodPost, "/api/v1/system/settings/smtp/test", "", configured.Header().Get("ETag"))
	if tested.Code != http.StatusServiceUnavailable {
		t.Fatalf("failed SMTP test status=%d body=%s, want 503", tested.Code, tested.Body.String())
	}
	current := fixture.serve(fixture.bootstrap, http.MethodGet, "/api/v1/system/settings", "", "")
	if current.Code != http.StatusOK {
		t.Fatalf("reload settings status=%d body=%s", current.Code, current.Body.String())
	}
	var settings systemadmin.Settings
	if err := json.Unmarshal(current.Body.Bytes(), &settings); err != nil {
		t.Fatalf("decode settings: %v", err)
	}
	if settings.SMTP.TestStatus != systemadmin.SMTPTestStatusFailed || settings.SMTP.TestedRevision != nil || settings.SMTP.Active {
		t.Fatalf("failed SMTP status was not persisted safely: %#v", settings.SMTP)
	}
	if bytes.Contains(current.Body.Bytes(), []byte("significant SMTP secret")) {
		t.Fatal("SMTP password appeared in settings response")
	}
	var auditCount int
	if err := fixture.db.QueryRowContext(context.Background(), `SELECT count(*) FROM system_audit_events WHERE action='system.smtp.test_failed'`).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatalf("failed SMTP audit count=%d err=%v", auditCount, err)
	}
}

func TestHostDefaultSMTPTestAttemptsDeliveryWithoutPersistingRevisionStatus(t *testing.T) {
	fixture := newSystemHTTPFixture(t, func(configuration *config.Config) {
		configuration.SMTP = config.SMTPConfig{
			Enabled: true, Host: "127.0.0.1", Port: 1, TLSMode: config.SMTPTLSModeTLS,
			Username: "mailer", Password: "smtp-secret", FromAddress: "teamtaler@example.test",
			AllowedPrivateHost: "127.0.0.1", AllowedPrivatePort: 1,
		}
	})
	settingsResponse := fixture.serve(fixture.bootstrap, http.MethodGet, "/api/v1/system/settings", "", "")
	if settingsResponse.Code != http.StatusOK {
		t.Fatalf("get settings status=%d body=%s", settingsResponse.Code, settingsResponse.Body.String())
	}
	var before systemadmin.Settings
	if err := json.Unmarshal(settingsResponse.Body.Bytes(), &before); err != nil {
		t.Fatalf("decode settings: %v", err)
	}
	if before.SMTP.RequiresTest || before.SMTP.Revision != 0 || !before.SMTP.Active {
		t.Fatalf("unexpected host-default SMTP state: %#v", before.SMTP)
	}

	tested := fixture.serve(fixture.bootstrap, http.MethodPost, "/api/v1/system/settings/smtp/test", "", settingsResponse.Header().Get("ETag"))
	if tested.Code != http.StatusServiceUnavailable {
		t.Fatalf("host-default SMTP test status=%d body=%s, want attempted delivery failure 503", tested.Code, tested.Body.String())
	}
	current := fixture.serve(fixture.bootstrap, http.MethodGet, "/api/v1/system/settings", "", "")
	var after systemadmin.Settings
	if err := json.Unmarshal(current.Body.Bytes(), &after); err != nil {
		t.Fatalf("decode current settings: %v", err)
	}
	if after.Revision != before.Revision || after.SMTP.TestStatus != before.SMTP.TestStatus {
		t.Fatalf("host-default SMTP test persisted revision state: before=%#v after=%#v", before.SMTP, after.SMTP)
	}
	var auditCount int
	if err := fixture.db.QueryRowContext(context.Background(), `SELECT count(*) FROM system_audit_events WHERE action='system.smtp.test_failed'`).Scan(&auditCount); err != nil || auditCount != 0 {
		t.Fatalf("host-default failed SMTP audit count=%d err=%v", auditCount, err)
	}
}

func TestSystemWebPushKeyRotationRequiresExplicitConfirmation(t *testing.T) {
	fixture := newSystemHTTPFixture(t, func(configuration *config.Config) {
		configuration.PushStorageKey = bytes.Repeat([]byte{0x24}, 32)
	})
	settingsResponse := fixture.serve(fixture.bootstrap, http.MethodGet, "/api/v1/system/settings", "", "")
	if settingsResponse.Code != http.StatusOK {
		t.Fatalf("get settings status=%d body=%s", settingsResponse.Code, settingsResponse.Body.String())
	}

	generated := fixture.serve(
		fixture.bootstrap,
		http.MethodPost,
		"/api/v1/system/settings/web-push/generate-key",
		"",
		settingsResponse.Header().Get("ETag"),
	)
	if generated.Code != http.StatusOK {
		t.Fatalf("initial Web Push key generation status=%d body=%s", generated.Code, generated.Body.String())
	}
	var initial systemadmin.Settings
	if err := json.Unmarshal(generated.Body.Bytes(), &initial); err != nil {
		t.Fatalf("decode generated Web Push settings: %v", err)
	}
	if !initial.WebPush.VAPIDPrivateKey.Configured || initial.WebPush.KeyID == "" || initial.WebPush.PublicKey == "" {
		t.Fatalf("initial Web Push key metadata is incomplete: %#v", initial.WebPush)
	}
	if bytes.Contains(generated.Body.Bytes(), []byte("privateKey")) {
		t.Fatal("Web Push private key field appeared in settings response")
	}

	rejected := fixture.serve(
		fixture.bootstrap,
		http.MethodPost,
		"/api/v1/system/settings/web-push/generate-key",
		`{}`,
		generated.Header().Get("ETag"),
	)
	if rejected.Code != http.StatusConflict {
		t.Fatalf("unconfirmed Web Push rotation status=%d body=%s, want 409", rejected.Code, rejected.Body.String())
	}

	rotated := fixture.serve(
		fixture.bootstrap,
		http.MethodPost,
		"/api/v1/system/settings/web-push/generate-key",
		`{"confirmRotation":true}`,
		generated.Header().Get("ETag"),
	)
	if rotated.Code != http.StatusOK {
		t.Fatalf("confirmed Web Push rotation status=%d body=%s", rotated.Code, rotated.Body.String())
	}
	var current systemadmin.Settings
	if err := json.Unmarshal(rotated.Body.Bytes(), &current); err != nil {
		t.Fatalf("decode rotated Web Push settings: %v", err)
	}
	if current.WebPush.KeyID == "" || current.WebPush.KeyID == initial.WebPush.KeyID {
		t.Fatalf("Web Push key ID was not rotated: before=%q after=%q", initial.WebPush.KeyID, current.WebPush.KeyID)
	}
	if current.Revision <= initial.Revision || current.WebPush.Revision <= initial.WebPush.Revision {
		t.Fatalf("Web Push revisions did not advance: before=%#v after=%#v", initial.WebPush, current.WebPush)
	}
}

type systemHTTPFixture struct {
	db            *sql.DB
	handler       http.Handler
	auth          auth.Service
	system        systemadmin.Service
	bootstrap     auth.Session
	baseURL       string
	dataDirectory string
}

func newSystemHTTPFixture(t *testing.T, configure ...func(*config.Config)) *systemHTTPFixture {
	t.Helper()
	ctx := context.Background()
	dataDirectory := t.TempDir()
	database, err := storage.Open(ctx, filepath.Join(dataDirectory, "teamtaler.db"))
	if err != nil {
		t.Fatalf("open system HTTP database: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	authentication := auth.Service{DB: database, SessionLifetime: 24 * time.Hour}
	if err := authentication.Bootstrap(ctx, "bootstrap@example.test", "Bootstrap", "bootstrap-password-long-enough", "Bootstrap Group", "EUR"); err != nil {
		t.Fatalf("bootstrap system HTTP fixture: %v", err)
	}
	bootstrap, err := authentication.Login(ctx, "bootstrap@example.test", "bootstrap-password-long-enough")
	if err != nil {
		t.Fatalf("login bootstrap account: %v", err)
	}
	publicURL := &url.URL{Scheme: "http", Host: "teamtaler.test"}
	configuration := config.Config{
		DataDirectory: dataDirectory, WebDirectory: t.TempDir(), PublicURL: publicURL,
		SessionLifetime: 24 * time.Hour, MaxRequestBytes: 6 << 20,
		EmailTokenKey: bytes.Repeat([]byte{0x42}, 32),
		InstanceDefaults: config.InstanceDefaults{
			InstanceName: "TeamTaler", DefaultCurrency: "EUR", MediaUploadMaxBytes: config.DefaultMediaUploadBytes,
			PublicJoinEnabled: true,
		},
	}
	for _, apply := range configure {
		apply(&configuration)
	}
	passwordCipher, err := systemadmin.NewSMTPPasswordCipher(configuration.EmailTokenKey)
	if err != nil {
		t.Fatalf("create SMTP password cipher: %v", err)
	}
	systemService, err := systemadmin.NewService(database, systemadmin.DefaultsFromConfig(configuration), passwordCipher)
	if err != nil {
		t.Fatalf("create system service: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return &systemHTTPFixture{
		db: database, handler: New(configuration, database, logger), auth: authentication,
		system: systemService, bootstrap: bootstrap, baseURL: publicURL.String(), dataDirectory: dataDirectory,
	}
}

func (fixture *systemHTTPFixture) createAccount(t *testing.T, email, displayName, password string) auth.Session {
	t.Helper()
	passwordHash, err := auth.HashPassword(password)
	if err != nil {
		t.Fatalf("hash account password: %v", err)
	}
	userID, _ := platform.NewID("usr")
	now := platform.Timestamp(platform.Now())
	if _, err := fixture.db.ExecContext(context.Background(), `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)`, userID, email, displayName, passwordHash, now, now); err != nil {
		t.Fatalf("insert account: %v", err)
	}
	session, err := fixture.auth.Login(context.Background(), email, password)
	if err != nil {
		t.Fatalf("login account: %v", err)
	}
	return session
}

func (fixture *systemHTTPFixture) serve(session auth.Session, method, path, body, ifMatch string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, fixture.baseURL+path, bytes.NewBufferString(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if ifMatch != "" {
		request.Header.Set("If-Match", ifMatch)
	}
	if session.Token != "" {
		request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: session.Token})
		request.AddCookie(&http.Cookie{Name: csrfCookieName, Value: session.CSRFToken})
		request.Header.Set("X-CSRF-Token", session.CSRFToken)
	}
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	return response
}

func (fixture *systemHTTPFixture) serveMultipart(session auth.Session, path string, imageBytes int64) *httptest.ResponseRecorder {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, _ := writer.CreateFormFile("image", "oversized.png")
	_, _ = part.Write(make([]byte, int(imageBytes)))
	_ = writer.Close()
	request := httptest.NewRequest(http.MethodPost, fixture.baseURL+path, &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: session.Token})
	request.AddCookie(&http.Cookie{Name: csrfCookieName, Value: session.CSRFToken})
	request.Header.Set("X-CSRF-Token", session.CSRFToken)
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	return response
}
