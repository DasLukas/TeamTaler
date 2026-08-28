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

func TestStatisticsHandlersEnforceIndependentPermissionsAndExactMoneyWire(t *testing.T) {
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
	server.handleMemberStatistics(disabled, request("/api/v1/groups/"+administrator.GroupID+"/statistics/members"))
	if disabled.Code != http.StatusForbidden {
		t.Fatalf("disabled member statistics status=%d body=%s", disabled.Code, disabled.Body.String())
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
	grant(domain.PermissionViewMemberStatistics)

	unsupportedRange := httptest.NewRecorder()
	server.handleMemberStatistics(unsupportedRange, request("/api/v1/groups/"+administrator.GroupID+"/statistics/members?range=UNSUPPORTED"))
	if unsupportedRange.Code != http.StatusUnprocessableEntity || !strings.Contains(unsupportedRange.Body.String(), "range: contains an unsupported statistics preset") {
		t.Fatalf("unsupported statistics range status=%d body=%s", unsupportedRange.Code, unsupportedRange.Body.String())
	}

	membersResponse := httptest.NewRecorder()
	server.handleMemberStatistics(membersResponse, request("/api/v1/groups/"+administrator.GroupID+"/statistics/members?range=CUSTOM&from=2026-08-28&to=2026-08-28"))
	if membersResponse.Code != http.StatusOK {
		t.Fatalf("member statistics status=%d body=%s", membersResponse.Code, membersResponse.Body.String())
	}
	var memberDashboard statistics.MemberDashboard
	if err := json.Unmarshal(membersResponse.Body.Bytes(), &memberDashboard); err != nil {
		t.Fatalf("decode member statistics: %v", err)
	}
	if memberDashboard.Meta.Preset != statistics.PresetCustom || memberDashboard.Meta.ToExclusive != memberDashboard.Meta.GeneratedAt || memberDashboard.Summary.CancellationRate != nil {
		t.Fatalf("member statistics contract=%#v", memberDashboard)
	}

	financeDenied := httptest.NewRecorder()
	server.handleFinanceStatistics(financeDenied, request("/api/v1/groups/"+administrator.GroupID+"/statistics/finance"))
	if financeDenied.Code != http.StatusForbidden {
		t.Fatalf("finance permission separation status=%d body=%s", financeDenied.Code, financeDenied.Body.String())
	}
	grant(domain.PermissionViewGroupStatistics)
	var periodID string
	if err := server.db.QueryRow(`SELECT id FROM periods WHERE group_id=? AND status='OPEN'`, administrator.GroupID).Scan(&periodID); err != nil {
		t.Fatalf("read statistics handler period: %v", err)
	}
	const exactAmount int64 = 9_007_199_254_740_993
	if _, err := server.db.Exec(`INSERT INTO ledger_entries(id,group_id,period_id,membership_id,account,amount_minor,description,created_at)
		VALUES('statistics-wire-ledger',?,?,?,'MEMBER_RECEIVABLE',?,'Exact amount','2026-08-28T09:00:00Z')`, administrator.GroupID, periodID, administrator.ID, exactAmount); err != nil {
		t.Fatalf("insert exact statistics amount: %v", err)
	}
	financeResponse := httptest.NewRecorder()
	server.handleFinanceStatistics(financeResponse, request("/api/v1/groups/"+administrator.GroupID+"/statistics/finance?range=CUSTOM&from=2026-08-28&to=2026-08-28"))
	if financeResponse.Code != http.StatusOK {
		t.Fatalf("finance statistics status=%d body=%s", financeResponse.Code, financeResponse.Body.String())
	}
	var document map[string]any
	if err := json.Unmarshal(financeResponse.Body.Bytes(), &document); err != nil {
		t.Fatalf("decode finance statistics wire: %v", err)
	}
	snapshot, ok := document["receivableSnapshot"].(map[string]any)
	if !ok || snapshot["netReceivableMinor"] != "9007199254740993" {
		t.Fatalf("finance exact minor-unit wire=%s", financeResponse.Body.String())
	}
}
