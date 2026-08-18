package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/memberimport"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
	systemadmin "github.com/DasLukas/TeamTaler/internal/system"
)

func TestHandleCreateInvitationQueuesEmailAndReturnsFallbackURL(t *testing.T) {
	t.Parallel()

	server, principal, membership := invitationImportServer(t, true)
	publicURL, err := url.Parse("https://teamtaler.example")
	if err != nil {
		t.Fatalf("parse public URL: %v", err)
	}
	server.config.PublicURL = publicURL
	memberRoleID := authorization.TemplateRoleID(membership.GroupID, domain.RoleTemplateMember)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/groups/"+membership.GroupID+"/invitations", bytes.NewBufferString(fmt.Sprintf(`{"email":"manual@example.test","displayName":"Manual Member","roleIds":[%q]}`, memberRoleID)))
	request.Header.Set("Content-Type", "application/json")
	request.SetPathValue("groupID", membership.GroupID)
	request = request.WithContext(context.WithValue(request.Context(), principalKey, principal))
	response := httptest.NewRecorder()

	server.handleCreateInvitation(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var result struct {
		Invitation groups.Invitation `json:"invitation"`
		AcceptURL  string            `json:"acceptUrl"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if result.Invitation.EmailDeliveryStatus != groups.EmailDeliveryPending || result.Invitation.Token != "" {
		t.Fatalf("invitation = %#v", result.Invitation)
	}
	if !strings.HasPrefix(result.AcceptURL, "https://teamtaler.example/invite#token=") {
		t.Fatalf("accept URL = %q", result.AcceptURL)
	}
	var jobs int
	if err := server.db.QueryRow(`SELECT count(*) FROM invitation_email_outbox WHERE invitation_id=?`, result.Invitation.ID).Scan(&jobs); err != nil || jobs != 1 {
		t.Fatalf("outbox jobs = %d err=%v, want 1", jobs, err)
	}
}

func TestMemberInvitationCanQueueEmailAfterSMTPIsEnabled(t *testing.T) {
	t.Parallel()

	server, principal, membership := invitationImportServer(t, true)
	publicURL, err := url.Parse("https://teamtaler.example")
	if err != nil {
		t.Fatalf("parse public URL: %v", err)
	}
	server.config.PublicURL = publicURL
	memberRoleID := authorization.TemplateRoleID(membership.GroupID, domain.RoleTemplateMember)
	createRequest := httptest.NewRequest(http.MethodPost, "/api/v1/groups/"+membership.GroupID+"/invitations", bytes.NewBufferString(fmt.Sprintf(`{"email":"later-smtp@example.test","displayName":"Later SMTP","roleIds":[%q]}`, memberRoleID)))
	createRequest.Header.Set("Content-Type", "application/json")
	createRequest.SetPathValue("groupID", membership.GroupID)
	createContext := context.WithValue(createRequest.Context(), principalKey, principal)
	createContext = context.WithValue(createContext, systemSettingsKey, systemadmin.Settings{SMTP: systemadmin.SMTPSettings{Active: false}})
	createRequest = createRequest.WithContext(createContext)
	createResponse := httptest.NewRecorder()

	server.handleCreateInvitation(createResponse, createRequest)
	if createResponse.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", createResponse.Code, createResponse.Body.String())
	}
	var created struct {
		Invitation groups.Invitation `json:"invitation"`
		AcceptURL  string            `json:"acceptUrl"`
	}
	if err := json.Unmarshal(createResponse.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	if created.Invitation.EmailDeliveryStatus != groups.EmailDeliveryNotRequested || created.AcceptURL == "" {
		t.Fatalf("created invitation = %#v acceptURL=%q", created.Invitation, created.AcceptURL)
	}

	resendRequest := httptest.NewRequest(http.MethodPost, "/api/v1/groups/"+membership.GroupID+"/invitations/"+created.Invitation.ID+"/email/resend", nil)
	resendRequest.Header.Set("Idempotency-Key", "enable-smtp-resend")
	resendRequest.SetPathValue("groupID", membership.GroupID)
	resendRequest.SetPathValue("invitationID", created.Invitation.ID)
	resendContext := context.WithValue(resendRequest.Context(), principalKey, principal)
	resendContext = context.WithValue(resendContext, systemSettingsKey, systemadmin.Settings{SMTP: systemadmin.SMTPSettings{Active: true}})
	resendRequest = resendRequest.WithContext(resendContext)
	resendResponse := httptest.NewRecorder()

	server.handleResendInvitationEmail(resendResponse, resendRequest)
	if resendResponse.Code != http.StatusOK {
		t.Fatalf("resend status = %d, body = %s", resendResponse.Code, resendResponse.Body.String())
	}
	var renewed struct {
		InvitationID        string                     `json:"invitationId"`
		EmailDeliveryStatus groups.EmailDeliveryStatus `json:"emailDeliveryStatus"`
		ExpiresAt           string                     `json:"expiresAt"`
		AcceptURL           string                     `json:"acceptUrl"`
	}
	if err := json.Unmarshal(resendResponse.Body.Bytes(), &renewed); err != nil {
		t.Fatalf("decode resend response: %v", err)
	}
	if renewed.InvitationID != created.Invitation.ID || renewed.EmailDeliveryStatus != groups.EmailDeliveryPending || renewed.ExpiresAt == "" || renewed.AcceptURL == "" || renewed.AcceptURL == created.AcceptURL {
		t.Fatalf("renewed invitation = %#v", renewed)
	}
	var jobs int
	var status string
	if err := server.db.QueryRow(`SELECT count(*),max(status) FROM invitation_email_outbox WHERE invitation_id=?`, created.Invitation.ID).Scan(&jobs, &status); err != nil || jobs != 1 || status != "PENDING" {
		t.Fatalf("outbox jobs=%d status=%q err=%v, want one pending job", jobs, status, err)
	}
}

func TestHandlePreviewInvitationReturnsOnlySafeHints(t *testing.T) {
	t.Parallel()

	server, principal, membership := invitationImportServer(t, false)
	invitation, err := server.groups.CreateInvitation(context.Background(), principal, membership, "preview@example.test", "Preview Member", []domain.Role{domain.RoleAdmin}, nil, nil)
	if err != nil {
		t.Fatalf("create invitation: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/invitations/preview", bytes.NewBufferString(`{"token":"`+invitation.Token+`"}`))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "192.0.2.40:12345"
	response := httptest.NewRecorder()

	server.handlePreviewInvitation(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var preview auth.InvitationPreview
	if err := json.Unmarshal(response.Body.Bytes(), &preview); err != nil {
		t.Fatalf("decode preview: %v", err)
	}
	if preview.DisplayName != "Preview Member" || preview.AccountState != auth.InvitationAccountNew {
		t.Fatalf("preview = %#v", preview)
	}
	responseText := response.Body.String()
	if strings.Contains(responseText, "preview@example.test") || strings.Contains(responseText, "ADMIN") || strings.Contains(responseText, "category") {
		t.Fatalf("preview leaked protected invitation data: %s", responseText)
	}
}

func TestHandleImportInvitationsQueuesValidRows(t *testing.T) {
	t.Parallel()

	server, principal, membership := invitationImportServer(t, true)
	request := invitationImportRequest(principal, membership.GroupID, "email,display_name\nnew@example.test,New Member\ninvalid,Bad\n", "text/csv; charset=utf-8")
	response := httptest.NewRecorder()
	server.handleImportInvitations(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var result groups.InvitationImportResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if result.Summary.Created != 1 || result.Summary.Invalid != 1 || result.Rows[0].EmailDeliveryStatus != groups.EmailDeliveryPending {
		t.Fatalf("result = %#v", result)
	}
	if strings.Contains(response.Body.String(), "token") {
		t.Fatalf("response contains token material: %s", response.Body.String())
	}
}

func TestHandleImportInvitationsUsesDefaultRoleWithoutQueryParameter(t *testing.T) {
	t.Parallel()

	server, principal, membership := invitationImportServer(t, true)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/groups/"+membership.GroupID+"/invitations/import", bytes.NewBufferString("email,roles\ndefault@example.test,\nfinance@example.test,Finanzverwaltung\n"))
	request.Header.Set("Content-Type", "text/csv")
	request.Header.Set("Idempotency-Key", "csv-default-role-test")
	request.SetPathValue("groupID", membership.GroupID)
	request = request.WithContext(context.WithValue(request.Context(), principalKey, principal))
	response := httptest.NewRecorder()

	server.handleImportInvitations(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var result groups.InvitationImportResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.Summary.Created != 2 {
		t.Fatalf("result=%#v err=%v", result, err)
	}
}

func TestHandleImportInvitationsValidatesTransportAndConfiguration(t *testing.T) {
	t.Parallel()

	server, principal, membership := invitationImportServer(t, false)
	tests := []struct {
		name        string
		body        string
		contentType string
		wantStatus  int
	}{
		{name: "unsupported media type", body: "email\na@example.test\n", contentType: "application/json", wantStatus: http.StatusUnsupportedMediaType},
		{name: "invalid header", body: "name\nAda\n", contentType: "text/csv", wantStatus: http.StatusUnprocessableEntity},
		{name: "mailer unavailable", body: "email\na@example.test\n", contentType: "text/csv", wantStatus: http.StatusServiceUnavailable},
		{name: "too large", body: strings.Repeat("x", memberimport.MaxCSVBytes+1), contentType: "text/csv", wantStatus: http.StatusRequestEntityTooLarge},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := invitationImportRequest(principal, membership.GroupID, test.body, test.contentType)
			response := httptest.NewRecorder()
			server.handleImportInvitations(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d, body = %s", response.Code, test.wantStatus, response.Body.String())
			}
		})
	}
}

func TestHandleImportInvitationsMapsGlobalBodyLimit(t *testing.T) {
	t.Parallel()

	server, principal, membership := invitationImportServer(t, true)
	request := invitationImportRequest(principal, membership.GroupID, "email\nmember@example.test\n", "text/csv")
	response := httptest.NewRecorder()
	request.Body = http.MaxBytesReader(response, request.Body, 8)

	server.handleImportInvitations(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d, body = %s", response.Code, http.StatusRequestEntityTooLarge, response.Body.String())
	}
}

func TestHandleRetryInvitationEmailRequiresConfiguredDelivery(t *testing.T) {
	t.Parallel()

	server, principal, membership := invitationImportServer(t, false)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/groups/"+membership.GroupID+"/invitations/inv_test/email/retry", nil)
	request.Header.Set("Idempotency-Key", "email-retry-test-key")
	request.SetPathValue("groupID", membership.GroupID)
	request.SetPathValue("invitationID", "inv_test")
	request = request.WithContext(context.WithValue(request.Context(), principalKey, principal))
	response := httptest.NewRecorder()

	server.handleRetryInvitationEmail(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d, body = %s", response.Code, http.StatusServiceUnavailable, response.Body.String())
	}
}

func invitationImportServer(t *testing.T, emailEnabled bool) (*Server, domain.Principal, domain.Membership) {
	t.Helper()
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := authService.Bootstrap(ctx, "admin@example.test", "Admin", "correct-horse-battery-staple", "Import Team", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	session, err := authService.Login(ctx, "admin@example.test", "correct-horse-battery-staple")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	groupService := groups.Service{DB: db}
	if emailEnabled {
		box, boxErr := platform.NewSecretBox([]byte("0123456789abcdef0123456789abcdef"))
		if boxErr != nil {
			t.Fatalf("secret box: %v", boxErr)
		}
		groupService.TokenSealer = box
	}
	groupItems, err := groupService.List(ctx, session.Principal.UserID)
	if err != nil || len(groupItems) != 1 {
		t.Fatalf("list groups: groups=%d err=%v", len(groupItems), err)
	}
	return &Server{db: db, auth: authService, groups: groupService, loginLimiter: newLoginLimiter()}, session.Principal, groupItems[0].Membership
}

func invitationImportRequest(principal domain.Principal, groupID, body, contentType string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/groups/"+groupID+"/invitations/import?roleId="+url.QueryEscape(authorization.TemplateRoleID(groupID, domain.RoleTemplateMember)), bytes.NewBufferString(body))
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Idempotency-Key", "csv-import-test-key")
	request.SetPathValue("groupID", groupID)
	request = request.WithContext(context.WithValue(request.Context(), principalKey, principal))
	return request
}
