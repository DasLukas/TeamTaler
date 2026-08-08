package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/config"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/platform"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestPublicJoinHTTPManagementRegistrationAndRotation(t *testing.T) {
	t.Parallel()

	server, principal, membership, box := publicJoinHTTPServer(t)
	createdResponse := httptest.NewRecorder()
	server.handlePutPublicJoinLink(createdResponse, publicJoinAdministratorRequest(principal, membership.GroupID, http.MethodPut, `{"enabled":true,"expiresAt":null}`))
	if createdResponse.Code != http.StatusOK {
		t.Fatalf("create status=%d body=%s", createdResponse.Code, createdResponse.Body.String())
	}
	var created publicJoinLinkResponse
	if err := json.Unmarshal(createdResponse.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode created link: %v", err)
	}
	if !created.Enabled || created.Expired || created.Version != 1 || created.AcceptURL == "" || createdResponse.Header().Get("ETag") != `"v1"` {
		t.Fatalf("created link=%#v ETag=%q", created, createdResponse.Header().Get("ETag"))
	}
	joinURL, err := url.Parse(created.AcceptURL)
	if err != nil {
		t.Fatalf("parse join URL: %v", err)
	}
	joinFragment, err := url.ParseQuery(joinURL.Fragment)
	if err != nil || joinFragment.Get("token") == "" || joinURL.Path != "/join" {
		t.Fatalf("join URL=%q fragment=%v err=%v", created.AcceptURL, joinFragment, err)
	}
	joinToken := joinFragment.Get("token")

	previewResponse := httptest.NewRecorder()
	server.handlePreviewPublicJoinLink(previewResponse, publicJoinJSONRequest(http.MethodPost, "/api/v1/public-join-links/preview", `{"token":"`+joinToken+`"}`))
	if previewResponse.Code != http.StatusOK || !bytes.Contains(previewResponse.Body.Bytes(), []byte(`"groupName":"HTTP Join Group"`)) {
		t.Fatalf("preview status=%d body=%s", previewResponse.Code, previewResponse.Body.String())
	}

	registrationResponse := httptest.NewRecorder()
	registrationBody := `{"joinToken":"` + joinToken + `","email":"new@example.test","displayName":"New Member","password":"new-member-password-long"}`
	server.handleStartPublicJoinRegistration(registrationResponse, publicJoinJSONRequest(http.MethodPost, "/api/v1/public-join-links/registrations", registrationBody))
	if registrationResponse.Code != http.StatusAccepted || registrationResponse.Body.String() != "{\"verificationRequired\":true}\n" {
		t.Fatalf("registration status=%d body=%s", registrationResponse.Code, registrationResponse.Body.String())
	}
	var encryptedVerificationToken string
	if err := server.db.QueryRowContext(context.Background(), `SELECT token_ciphertext FROM public_join_email_outbox WHERE group_id=?`, membership.GroupID).Scan(&encryptedVerificationToken); err != nil {
		t.Fatalf("read verification outbox: %v", err)
	}
	verificationToken, err := box.Open(encryptedVerificationToken)
	if err != nil {
		t.Fatalf("decrypt verification token: %v", err)
	}
	confirmationResponse := httptest.NewRecorder()
	server.handleConfirmPublicJoinRegistration(confirmationResponse, publicJoinJSONRequest(http.MethodPost, "/api/v1/public-join-links/registrations/confirm", `{"token":"`+verificationToken+`"}`))
	if confirmationResponse.Code != http.StatusCreated || confirmationResponse.Header().Get("Set-Cookie") == "" {
		t.Fatalf("confirmation status=%d cookies=%q body=%s", confirmationResponse.Code, confirmationResponse.Header().Values("Set-Cookie"), confirmationResponse.Body.String())
	}

	staleResponse := httptest.NewRecorder()
	server.handlePutPublicJoinLink(staleResponse, publicJoinAdministratorRequest(principal, membership.GroupID, http.MethodPut, `{"enabled":true,"expiresAt":null}`))
	if staleResponse.Code != http.StatusPreconditionFailed {
		t.Fatalf("missing update precondition status=%d body=%s", staleResponse.Code, staleResponse.Body.String())
	}
	rotateRequest := publicJoinAdministratorRequest(principal, membership.GroupID, http.MethodPost, "")
	rotateRequest.Header.Set("If-Match", `"v1"`)
	rotateResponse := httptest.NewRecorder()
	server.handleRotatePublicJoinLink(rotateResponse, rotateRequest)
	if rotateResponse.Code != http.StatusOK || rotateResponse.Header().Get("ETag") != `"v2"` {
		t.Fatalf("rotate status=%d ETag=%q body=%s", rotateResponse.Code, rotateResponse.Header().Get("ETag"), rotateResponse.Body.String())
	}
	oldPreviewResponse := httptest.NewRecorder()
	server.handlePreviewPublicJoinLink(oldPreviewResponse, publicJoinJSONRequest(http.MethodPost, "/api/v1/public-join-links/preview", `{"token":"`+joinToken+`"}`))
	if oldPreviewResponse.Code != http.StatusNotFound {
		t.Fatalf("old token preview status=%d body=%s", oldPreviewResponse.Code, oldPreviewResponse.Body.String())
	}
}

func publicJoinHTTPServer(t *testing.T) (*Server, domain.Principal, domain.Membership, platform.SecretBox) {
	t.Helper()
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "public-join-http.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	box, err := platform.NewSecretBox([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("secret box: %v", err)
	}
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour, TokenSealer: box, EmailDeliveryAvailable: true}
	if err := authService.Bootstrap(ctx, "admin@example.test", "Admin", "correct-horse-battery-staple", "HTTP Join Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	session, err := authService.Login(ctx, "admin@example.test", "correct-horse-battery-staple")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	groupService := groups.Service{DB: db, TokenSealer: box, TokenOpener: box, EmailDeliveryAvailable: true}
	groupItems, err := groupService.List(ctx, session.Principal.UserID)
	if err != nil || len(groupItems) != 1 {
		t.Fatalf("list groups: groups=%d err=%v", len(groupItems), err)
	}
	publicURL, err := url.Parse("https://teamtaler.example")
	if err != nil {
		t.Fatalf("parse public URL: %v", err)
	}
	return &Server{
		config: config.Config{PublicURL: publicURL, SessionLifetime: 24 * time.Hour},
		db:     db, auth: authService, groups: groupService, loginLimiter: newLoginLimiter(), passwordSlots: make(chan struct{}, 2),
	}, session.Principal, groupItems[0].Membership, box
}

func publicJoinAdministratorRequest(principal domain.Principal, groupID, method, body string) *http.Request {
	request := publicJoinJSONRequest(method, "/api/v1/groups/"+groupID+"/public-join-link", body)
	request.SetPathValue("groupID", groupID)
	return request.WithContext(context.WithValue(request.Context(), principalKey, principal))
}

func publicJoinJSONRequest(method, path, body string) *http.Request {
	request := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	return request
}
