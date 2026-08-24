package httpapi

import (
	"context"
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

func TestAppearanceHandlersPersistAccountAndPerGroupPreferences(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "appearance.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Close()
	authService := auth.Service{DB: db, SessionLifetime: 24 * time.Hour}
	if err := authService.Bootstrap(ctx, "appearance@example.test", "Appearance", "correct-horse-battery-staple", "Appearance Group", "EUR"); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	session, err := authService.Login(ctx, "appearance@example.test", "correct-horse-battery-staple")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	groupService := groups.Service{DB: db}
	groupItems, err := groupService.List(ctx, session.Principal.UserID)
	if err != nil || len(groupItems) != 1 {
		t.Fatalf("list groups: items=%#v err=%v", groupItems, err)
	}
	if groupItems[0].DefaultTheme != domain.ThemeTeamTaler || groupItems[0].Membership.ThemeOverride != nil {
		t.Fatalf("default group appearance=%#v", groupItems[0])
	}
	server := &Server{auth: authService, groups: groupService}
	payload, err := server.newSessionResponse(ctx, session.Principal, session.CSRFToken, groupItems)
	if err != nil || payload.ColorMode != domain.ColorModeSystem {
		t.Fatalf("default session appearance=%#v err=%v", payload, err)
	}

	appearanceRequest := authenticatedJSONRequest(http.MethodPut, "/api/v1/me/appearance", `{"colorMode":"DARK"}`, session.Principal)
	appearanceResponse := httptest.NewRecorder()
	server.handleUpdateAppearance(appearanceResponse, appearanceRequest)
	if appearanceResponse.Code != http.StatusOK || appearanceResponse.Body.String() != "{\"colorMode\":\"DARK\"}\n" {
		t.Fatalf("appearance response status=%d body=%q", appearanceResponse.Code, appearanceResponse.Body.String())
	}
	mode, err := authService.ReadColorMode(ctx, session.Principal.UserID)
	if err != nil || mode != domain.ColorModeDark {
		t.Fatalf("persisted color mode=%q err=%v", mode, err)
	}

	groupID := groupItems[0].ID
	themeRequest := authenticatedJSONRequest(http.MethodPut, "/api/v1/groups/"+groupID+"/theme-preference", `{"themeOverride":"TIEF_IM_WESTEN"}`, session.Principal)
	themeRequest.SetPathValue("groupID", groupID)
	themeResponse := httptest.NewRecorder()
	server.handleUpdateThemePreference(themeResponse, themeRequest)
	if themeResponse.Code != http.StatusOK || themeResponse.Body.String() != "{\"themeOverride\":\"TIEF_IM_WESTEN\"}\n" {
		t.Fatalf("theme response status=%d body=%q", themeResponse.Code, themeResponse.Body.String())
	}
	updatedGroups, err := groupService.List(ctx, session.Principal.UserID)
	if err != nil || updatedGroups[0].Membership.ThemeOverride == nil || *updatedGroups[0].Membership.ThemeOverride != domain.ThemeTiefImWesten {
		t.Fatalf("persisted group override=%#v err=%v", updatedGroups, err)
	}

	resetRequest := authenticatedJSONRequest(http.MethodPut, "/api/v1/groups/"+groupID+"/theme-preference", `{"themeOverride":null}`, session.Principal)
	resetRequest.SetPathValue("groupID", groupID)
	resetResponse := httptest.NewRecorder()
	server.handleUpdateThemePreference(resetResponse, resetRequest)
	if resetResponse.Code != http.StatusOK || resetResponse.Body.String() != "{\"themeOverride\":null}\n" {
		t.Fatalf("theme reset status=%d body=%q", resetResponse.Code, resetResponse.Body.String())
	}
	updatedGroups, err = groupService.List(ctx, session.Principal.UserID)
	if err != nil || updatedGroups[0].Membership.ThemeOverride != nil {
		t.Fatalf("reset group override=%#v err=%v", updatedGroups, err)
	}
}

func TestAppearanceHandlersRejectMissingUnknownAndUnsupportedValues(t *testing.T) {
	server := &Server{auth: auth.Service{DB: openPreferenceValidationDatabase(t)}, groups: groups.Service{DB: openPreferenceValidationDatabase(t)}}
	principal := domain.Principal{UserID: "user-one"}
	for name, body := range map[string]string{
		"missing mode":  `{}`,
		"unknown mode":  `{"colorMode":"AUTO"}`,
		"unknown field": `{"colorMode":"SYSTEM","unexpected":true}`,
	} {
		t.Run(name, func(t *testing.T) {
			request := authenticatedJSONRequest(http.MethodPut, "/api/v1/me/appearance", body, principal)
			response := httptest.NewRecorder()
			server.handleUpdateAppearance(response, request)
			if response.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status=%d body=%q", response.Code, response.Body.String())
			}
		})
	}

	groupServer, groupPrincipal, administrator := invitationImportServer(t, false)
	for name, body := range map[string]string{
		"missing override": `{}`,
		"unknown override": `{"themeOverride":"UNKNOWN"}`,
		"wrong type":       `{"themeOverride":42}`,
	} {
		t.Run(name, func(t *testing.T) {
			request := roleHandlerRequest(groupPrincipal, administrator.GroupID, http.MethodPut, body)
			response := httptest.NewRecorder()
			groupServer.handleUpdateThemePreference(response, request)
			if response.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status=%d body=%q", response.Code, response.Body.String())
			}
		})
	}

	foreign := authenticatedJSONRequest(http.MethodPut, "/api/v1/groups/missing/theme-preference", `{"themeOverride":"NRW"}`, groupPrincipal)
	foreign.SetPathValue("groupID", "missing")
	foreignResponse := httptest.NewRecorder()
	groupServer.handleUpdateThemePreference(foreignResponse, foreign)
	if foreignResponse.Code != http.StatusForbidden || !strings.Contains(foreignResponse.Body.String(), "not permitted") {
		t.Fatalf("foreign group status=%d body=%q", foreignResponse.Code, foreignResponse.Body.String())
	}
}
