package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/config"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/kiosk"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestKioskPosterHTTPAuthorizationVersionsAndTenantScope(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	db, err := storage.Open(ctx, filepath.Join(directory, "teamtaler.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := authService.Bootstrap(ctx, "poster-http-admin@example.test", "Poster Admin", "poster-route-password-long", "Poster Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	adminSession, err := authService.Login(ctx, "poster-http-admin@example.test", "poster-route-password-long")
	if err != nil {
		t.Fatalf("admin login: %v", err)
	}
	groupService := groups.Service{DB: db}
	groupItems, err := groupService.List(ctx, adminSession.Principal.UserID)
	if err != nil || len(groupItems) != 1 {
		t.Fatalf("list groups: count=%d error=%v", len(groupItems), err)
	}
	groupID := groupItems[0].ID
	if _, err := db.ExecContext(ctx, `INSERT INTO categories(id,group_id,name,created_at,updated_at) VALUES('poster-route-category',?,'Drinks','2026-09-23T00:00:00Z','2026-09-23T00:00:00Z')`, groupID); err != nil {
		t.Fatalf("insert poster category: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO products(id,group_id,category_id,name,price_minor,created_at,updated_at) VALUES('poster-route-product',?,'poster-route-category','Water',125,'2026-09-23T00:00:00Z','2026-09-23T00:00:00Z')`, groupID); err != nil {
		t.Fatalf("insert poster product: %v", err)
	}
	other, err := groupService.Create(ctx, adminSession.Principal, "Other Group", "EUR")
	if err != nil {
		t.Fatalf("create second group: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at)
		SELECT 'poster-basic-user','poster-basic@example.test','Basic Member',password_hash,'2026-09-23T00:00:00Z','2026-09-23T00:00:00Z'
		FROM users WHERE id=?`, adminSession.Principal.UserID); err != nil {
		t.Fatalf("insert member account: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO memberships(id,group_id,user_id,status,joined_at)
		VALUES('poster-basic-membership',?,'poster-basic-user','ACTIVE','2026-09-23T00:00:00Z')`, groupID); err != nil {
		t.Fatalf("insert member: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO membership_role_assignments(group_id,membership_id,role_id,assigned_at)
		VALUES(?,'poster-basic-membership',?,'2026-09-23T00:00:00Z')`, groupID, authorization.TemplateRoleID(groupID, domain.RoleTemplateMember)); err != nil {
		t.Fatalf("assign member role: %v", err)
	}
	memberSession, err := authService.Login(ctx, "poster-basic@example.test", "poster-route-password-long")
	if err != nil {
		t.Fatalf("member login: %v", err)
	}
	publicURL := &url.URL{Scheme: "https", Host: "teamtaler.example.test"}
	handler := New(config.Config{
		DataDirectory: directory, WebDirectory: t.TempDir(), PublicURL: publicURL,
		SessionLifetime: 24 * time.Hour, MaxRequestBytes: 1 << 20,
	}, db, NewBuildInformation("test", "kiosk-poster-routes"), slog.New(slog.NewTextHandler(io.Discard, nil)))
	path := "/api/v1/groups/" + groupID + "/kiosk-posters"
	request := func(method, target, body, ifMatch string, session *auth.Session) *httptest.ResponseRecorder {
		t.Helper()
		item := httptest.NewRequest(method, publicURL.String()+target, bytes.NewBufferString(body))
		if body != "" {
			item.Header.Set("Content-Type", "application/json")
		}
		if ifMatch != "" {
			item.Header.Set("If-Match", ifMatch)
		}
		if session != nil {
			item.AddCookie(&http.Cookie{Name: sessionCookieName, Value: session.Token})
			item.AddCookie(&http.Cookie{Name: csrfCookieName, Value: session.CSRFToken})
			item.Header.Set("X-CSRF-Token", session.CSRFToken)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, item)
		return response
	}
	if result := request(http.MethodGet, path, "", "", nil); result.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous list status=%d, want 401", result.Code)
	}
	if result := request(http.MethodGet, path, "", "", &memberSession); result.Code != http.StatusForbidden {
		t.Fatalf("member list status=%d, want 403; body=%s", result.Code, result.Body.String())
	}
	if result := request(http.MethodPost, path, `{"name":"No","text":"","productIds":[]}`, "", &memberSession); result.Code != http.StatusForbidden {
		t.Fatalf("member create status=%d, want 403; body=%s", result.Code, result.Body.String())
	}
	createdResponse := request(http.MethodPost, path, `{"name":"Group poster","text":"Scan here","productIds":["poster-route-product"]}`, "", &adminSession)
	if createdResponse.Code != http.StatusCreated || createdResponse.Header().Get("ETag") != `"v1"` {
		t.Fatalf("create status=%d etag=%q body=%s", createdResponse.Code, createdResponse.Header().Get("ETag"), createdResponse.Body.String())
	}
	var created kiosk.Poster
	if err := json.Unmarshal(createdResponse.Body.Bytes(), &created); err != nil || created.ID == "" || created.Version != 1 {
		t.Fatalf("decode created poster=%#v error=%v", created, err)
	}
	itemPath := path + "/" + created.ID
	if result := request(http.MethodGet, path, "", "", &adminSession); result.Code != http.StatusOK {
		t.Fatalf("admin list status=%d body=%s", result.Code, result.Body.String())
	} else {
		var listed []kiosk.Poster
		if err := json.Unmarshal(result.Body.Bytes(), &listed); err != nil || len(listed) != 2 || !listed[0].IsDefault || listed[0].Name != "Standard" || listed[1].IsDefault {
			t.Fatalf("listed posters=%#v error=%v", listed, err)
		}
		standardPath := path + "/" + listed[0].ID
		if result := request(http.MethodDelete, standardPath, "", `"v1"`, &adminSession); result.Code != http.StatusConflict {
			t.Fatalf("delete standard status=%d, want 409; body=%s", result.Code, result.Body.String())
		}
	}
	if result := request(http.MethodGet, itemPath+"/pdf", "", "", &adminSession); result.Code != http.StatusConflict {
		t.Fatalf("disabled PDF status=%d, want 409; body=%s", result.Code, result.Body.String())
	}
	if result := request(http.MethodPut, itemPath, `{"name":"Edited","text":"","productIds":["poster-route-product"]}`, "", &adminSession); result.Code != http.StatusPreconditionFailed {
		t.Fatalf("missing If-Match status=%d, want 412", result.Code)
	}
	if result := request(http.MethodPut, itemPath, `{"name":"Edited","text":"","productIds":["poster-route-product"]}`, `"v2"`, &adminSession); result.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale update status=%d, want 412", result.Code)
	}
	updated := request(http.MethodPut, itemPath, `{"name":"Edited","text":"","productIds":["poster-route-product"]}`, `"v1"`, &adminSession)
	if updated.Code != http.StatusOK || updated.Header().Get("ETag") != `"v2"` {
		t.Fatalf("update status=%d etag=%q body=%s", updated.Code, updated.Header().Get("ETag"), updated.Body.String())
	}
	if _, err := db.ExecContext(ctx, `UPDATE group_settings SET kiosk_enabled=1 WHERE group_id=?`, groupID); err != nil {
		t.Fatalf("enable kiosk: %v", err)
	}
	if result := request(http.MethodGet, itemPath+"/pdf", "", "", &memberSession); result.Code != http.StatusForbidden {
		t.Fatalf("member PDF status=%d, want 403", result.Code)
	}
	pdf := request(http.MethodGet, itemPath+"/pdf", "", "", &adminSession)
	if pdf.Code != http.StatusOK || pdf.Header().Get("Content-Type") != "application/pdf" || !bytes.HasPrefix(pdf.Body.Bytes(), []byte("%PDF-")) {
		t.Fatalf("PDF status=%d type=%q bytes=%d", pdf.Code, pdf.Header().Get("Content-Type"), pdf.Body.Len())
	}
	otherPath := "/api/v1/groups/" + other.ID + "/kiosk-posters/" + created.ID
	if result := request(http.MethodGet, otherPath+"/pdf", "", "", &adminSession); result.Code != http.StatusConflict {
		// The second group's disabled switch is checked before poster lookup.
		t.Fatalf("cross-group disabled PDF status=%d, want 409", result.Code)
	}
	if _, err := db.ExecContext(ctx, `UPDATE group_settings SET kiosk_enabled=1 WHERE group_id=?`, other.ID); err != nil {
		t.Fatalf("enable second group kiosk: %v", err)
	}
	if result := request(http.MethodGet, otherPath+"/pdf", "", "", &adminSession); result.Code != http.StatusNotFound {
		t.Fatalf("cross-group PDF status=%d, want 404", result.Code)
	}
	if result := request(http.MethodPut, otherPath, `{"name":"Hijacked","text":"","productIds":[]}`, `"v2"`, &adminSession); result.Code != http.StatusNotFound {
		t.Fatalf("cross-group update status=%d, want 404", result.Code)
	}
	if result := request(http.MethodDelete, itemPath, "", `"v1"`, &adminSession); result.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale delete status=%d, want 412", result.Code)
	}
	if result := request(http.MethodDelete, itemPath, "", `"v2"`, &memberSession); result.Code != http.StatusForbidden {
		t.Fatalf("member delete status=%d, want 403", result.Code)
	}
	if result := request(http.MethodDelete, itemPath, "", `"v2"`, &adminSession); result.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d, want 204; body=%s", result.Code, result.Body.String())
	}
}
