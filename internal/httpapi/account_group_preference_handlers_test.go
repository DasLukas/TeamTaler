package httpapi

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestAccountGroupPreferenceControlsSubsequentSessionSelection(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "group-preference.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := authService.Bootstrap(ctx, "member@example.test", "Member", "correct-horse-battery-staple", "First Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	session, err := authService.Login(ctx, "member@example.test", "correct-horse-battery-staple")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	groupService := groups.Service{DB: db}
	firstGroups, err := groupService.List(ctx, session.Principal.UserID)
	if err != nil || len(firstGroups) != 1 {
		t.Fatalf("list first group: groups=%#v err=%v", firstGroups, err)
	}
	secondGroup, err := groupService.Create(ctx, session.Principal, "Second Group", "EUR")
	if err != nil {
		t.Fatalf("create second group: %v", err)
	}
	groupItems, err := groupService.List(ctx, session.Principal.UserID)
	if err != nil || len(groupItems) != 2 {
		t.Fatalf("list groups: groups=%#v err=%v", groupItems, err)
	}
	server := &Server{auth: authService}

	record := authenticatedJSONRequest(http.MethodPut, "/api/v1/me/group-preference/last-used", `{"groupId":"`+secondGroup.ID+`"}`, session.Principal)
	lastUsedResponse := httptest.NewRecorder()
	server.handleRecordLastUsedGroup(lastUsedResponse, record)
	if lastUsedResponse.Code != http.StatusNoContent {
		t.Fatalf("record last-used status=%d body=%q", lastUsedResponse.Code, lastUsedResponse.Body.String())
	}
	payload, err := server.newSessionResponse(ctx, session.Principal, session.CSRFToken, groupItems)
	if err != nil || payload.ActiveGroupID == nil || *payload.ActiveGroupID != secondGroup.ID || payload.DefaultGroupID != nil {
		t.Fatalf("last-used session payload=%#v err=%v", payload, err)
	}

	firstGroupID := firstGroups[0].ID
	update := authenticatedJSONRequest(http.MethodPut, "/api/v1/me/group-preference", `{"defaultGroupId":"`+firstGroupID+`"}`, session.Principal)
	updateResponse := httptest.NewRecorder()
	server.handleUpdateDefaultGroup(updateResponse, update)
	if updateResponse.Code != http.StatusOK || !strings.Contains(updateResponse.Body.String(), firstGroupID) {
		t.Fatalf("fixed default status=%d body=%q", updateResponse.Code, updateResponse.Body.String())
	}
	payload, err = server.newSessionResponse(ctx, session.Principal, session.CSRFToken, groupItems)
	if err != nil || payload.ActiveGroupID == nil || *payload.ActiveGroupID != firstGroupID || payload.DefaultGroupID == nil || *payload.DefaultGroupID != firstGroupID {
		t.Fatalf("fixed-default session payload=%#v err=%v", payload, err)
	}

	useLast := authenticatedJSONRequest(http.MethodPut, "/api/v1/me/group-preference", `{"defaultGroupId":null}`, session.Principal)
	useLastResponse := httptest.NewRecorder()
	server.handleUpdateDefaultGroup(useLastResponse, useLast)
	if useLastResponse.Code != http.StatusOK || useLastResponse.Body.String() != "{\"defaultGroupId\":null}\n" {
		t.Fatalf("last-used mode status=%d body=%q", useLastResponse.Code, useLastResponse.Body.String())
	}
	payload, err = server.newSessionResponse(ctx, session.Principal, session.CSRFToken, groupItems)
	if err != nil || payload.ActiveGroupID == nil || *payload.ActiveGroupID != secondGroup.ID || payload.DefaultGroupID != nil {
		t.Fatalf("restored last-used session payload=%#v err=%v", payload, err)
	}

	now := "2026-08-15T12:00:00Z"
	if _, err := db.ExecContext(ctx, `UPDATE groups SET status='ARCHIVED',archived_from_status='ACTIVE',archived_at=?,archived_by=?,version=version+1,updated_at=? WHERE id=?`, now, session.Principal.UserID, now, secondGroup.ID); err != nil {
		t.Fatalf("archive preference group: %v", err)
	}
	for name, request := range map[string]*http.Request{
		"default":   authenticatedJSONRequest(http.MethodPut, "/api/v1/me/group-preference", `{"defaultGroupId":"`+secondGroup.ID+`"}`, session.Principal),
		"last-used": authenticatedJSONRequest(http.MethodPut, "/api/v1/me/group-preference/last-used", `{"groupId":"`+secondGroup.ID+`"}`, session.Principal),
	} {
		response := httptest.NewRecorder()
		if name == "default" {
			server.handleUpdateDefaultGroup(response, request)
		} else {
			server.handleRecordLastUsedGroup(response, request)
		}
		if response.Code != http.StatusUnprocessableEntity {
			t.Fatalf("archived %s preference status=%d body=%q, want 422", name, response.Code, response.Body.String())
		}
	}
}

func TestAccountGroupPreferenceRejectsUnavailableGroupsAndMissingMode(t *testing.T) {
	server := &Server{auth: auth.Service{DB: openPreferenceValidationDatabase(t)}}
	principal := domain.Principal{UserID: "user-one"}
	for name, testCase := range map[string]struct {
		path    string
		body    string
		handler func(http.ResponseWriter, *http.Request)
	}{
		"unknown default":   {path: "/api/v1/me/group-preference", body: `{"defaultGroupId":"group-missing"}`, handler: server.handleUpdateDefaultGroup},
		"missing default":   {path: "/api/v1/me/group-preference", body: `{}`, handler: server.handleUpdateDefaultGroup},
		"unknown last-used": {path: "/api/v1/me/group-preference/last-used", body: `{"groupId":"group-missing"}`, handler: server.handleRecordLastUsedGroup},
	} {
		t.Run(name, func(t *testing.T) {
			request := authenticatedJSONRequest(http.MethodPut, testCase.path, testCase.body, principal)
			response := httptest.NewRecorder()
			testCase.handler(response, request)
			if response.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status=%d body=%q, want 422", response.Code, response.Body.String())
			}
		})
	}
}

func authenticatedJSONRequest(method, path, body string, principal domain.Principal) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	return request.WithContext(context.WithValue(request.Context(), principalKey, principal))
}

func openPreferenceValidationDatabase(t *testing.T) *sql.DB {
	t.Helper()
	db, err := storage.Open(context.Background(), filepath.Join(t.TempDir(), "preference-validation.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	const now = "2026-08-15T10:00:00Z"
	if _, err := db.Exec(`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-one','one@example.test','One','hash',?,?)`, now, now); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	return db
}
