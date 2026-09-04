package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/statistics"
)

func TestStatisticsHandlerEnforcesUnifiedAccessAndExactMoneyWire(t *testing.T) {
	server, principal, administrator := invitationImportServer(t, false)
	clock := time.Date(2026, time.August, 28, 12, 0, 0, 0, time.UTC)
	server.statistics = statistics.Service{DB: server.db, Clock: func() time.Time { return clock }}
	if _, err := server.db.Exec(`UPDATE memberships SET joined_at='2026-08-01T00:00:00Z' WHERE id=?`, administrator.ID); err != nil {
		t.Fatalf("move statistics handler membership before selected range: %v", err)
	}
	request := func(path string) *http.Request {
		item := httptest.NewRequest(http.MethodGet, path, nil)
		item.SetPathValue("groupID", administrator.GroupID)
		return item.WithContext(context.WithValue(item.Context(), principalKey, principal))
	}

	disabled := httptest.NewRecorder()
	server.handleStatistics(disabled, request("/api/v1/groups/"+administrator.GroupID+"/statistics"))
	if disabled.Code != http.StatusForbidden {
		t.Fatalf("disabled statistics status=%d body=%s", disabled.Code, disabled.Body.String())
	}
	enabled := true
	if _, err := server.groups.UpdateSettings(context.Background(), principal, administrator, groups.SettingsUpdate{StatisticsEnabled: &enabled}); err != nil {
		t.Fatalf("enable statistics handler fixture: %v", err)
	}
	roleID := authorization.PresetRoleID(administrator.GroupID, domain.RolePresetGroupAdministrator)
	grant := func(permission domain.PermissionKey) {
		t.Helper()
		if _, err := server.db.Exec(`INSERT INTO role_permission_grants(group_id,role_id,permission_key,scope_type,version,created_at,updated_at)
			VALUES(?,?,?,'GROUP',1,'2026-08-28T10:00:00Z','2026-08-28T10:00:00Z')`, administrator.GroupID, roleID, permission); err != nil {
			t.Fatalf("grant handler permission %s: %v", permission, err)
		}
	}

	permissionDenied := httptest.NewRecorder()
	server.handleStatistics(permissionDenied, request("/api/v1/groups/"+administrator.GroupID+"/statistics"))
	if permissionDenied.Code != http.StatusForbidden {
		t.Fatalf("ungranted statistics status=%d body=%s", permissionDenied.Code, permissionDenied.Body.String())
	}
	grant(domain.PermissionViewStatistics)

	unsupportedRange := httptest.NewRecorder()
	server.handleStatistics(unsupportedRange, request("/api/v1/groups/"+administrator.GroupID+"/statistics?range=UNSUPPORTED"))
	if unsupportedRange.Code != http.StatusUnprocessableEntity || !strings.Contains(unsupportedRange.Body.String(), "range: contains an unsupported statistics preset") {
		t.Fatalf("unsupported statistics range status=%d body=%s", unsupportedRange.Code, unsupportedRange.Body.String())
	}

	var periodID string
	if err := server.db.QueryRow(`SELECT id FROM periods WHERE group_id=? AND status='OPEN'`, administrator.GroupID).Scan(&periodID); err != nil {
		t.Fatalf("read statistics handler period: %v", err)
	}
	const exactAmount int64 = 9_007_199_254_740_993
	if _, err := server.db.Exec(`INSERT INTO ledger_entries(id,group_id,period_id,membership_id,account,amount_minor,description,created_at)
		VALUES('statistics-wire-ledger',?,?,?,'MEMBER_RECEIVABLE',?,'Exact amount','2026-08-28T09:00:00Z')`, administrator.GroupID, periodID, administrator.ID, exactAmount); err != nil {
		t.Fatalf("insert exact statistics amount: %v", err)
	}
	response := httptest.NewRecorder()
	server.handleStatistics(response, request("/api/v1/groups/"+administrator.GroupID+"/statistics?range=CUSTOM&from=2026-08-28&to=2026-08-28"))
	if response.Code != http.StatusOK {
		t.Fatalf("statistics status=%d body=%s", response.Code, response.Body.String())
	}
	var dashboard statistics.Dashboard
	if err := json.Unmarshal(response.Body.Bytes(), &dashboard); err != nil {
		t.Fatalf("decode statistics: %v", err)
	}
	if dashboard.Meta.Preset != statistics.PresetCustom || dashboard.Meta.ToExclusive != dashboard.Meta.GeneratedAt || dashboard.Members.Summary.CancellationRate != nil {
		t.Fatalf("statistics contract=%#v", dashboard)
	}
	var document map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatalf("decode finance statistics wire: %v", err)
	}
	members, membersOK := document["members"].(map[string]any)
	finance, financeOK := document["finance"].(map[string]any)
	snapshot, ok := finance["receivableSnapshot"].(map[string]any)
	if !ok || snapshot["netReceivableMinor"] != "9007199254740993" {
		t.Fatalf("finance exact minor-unit wire=%s", response.Body.String())
	}
	if !membersOK || !financeOK || members["meta"] != nil || finance["meta"] != nil {
		t.Fatalf("statistics sections must share top-level meta: %s", response.Body.String())
	}
}
