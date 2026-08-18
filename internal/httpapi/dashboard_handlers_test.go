package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/bookings"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/finance"
	"github.com/DasLukas/TeamTaler/internal/periods"
)

func TestDashboardGroupOutstandingUsesStatisticsPermission(t *testing.T) {
	server, principal, administrator := invitationImportServer(t, false)
	server.finance = finance.Service{DB: server.db}
	server.bookings = bookings.Service{DB: server.db}
	server.periods = periods.Service{DB: server.db}

	var periodID string
	if err := server.db.QueryRow(`SELECT id FROM periods WHERE group_id=? AND status='OPEN'`, administrator.GroupID).Scan(&periodID); err != nil {
		t.Fatalf("read open period: %v", err)
	}
	for _, entry := range []struct {
		id     string
		amount int64
	}{
		{id: "dashboard-charge", amount: 500},
		{id: "dashboard-payment", amount: -650},
	} {
		if _, err := server.db.Exec(`INSERT INTO ledger_entries(id,group_id,period_id,membership_id,account,amount_minor,description,created_at) VALUES(?,?,?,?,?,?,?,?)`,
			entry.id, administrator.GroupID, periodID, administrator.ID, "MEMBER_RECEIVABLE", entry.amount, entry.id, "2026-08-11T12:00:00Z"); err != nil {
			t.Fatalf("insert %s: %v", entry.id, err)
		}
	}
	administratorRoleID := authorization.PresetRoleID(administrator.GroupID, domain.RolePresetGroupAdministrator)
	if _, err := server.db.Exec(`INSERT INTO role_permission_grants(group_id,role_id,permission_key,scope_type,version,created_at,updated_at) VALUES(?,?,'VIEW_GROUP_STATISTICS','GROUP',1,?,?)`, administrator.GroupID, administratorRoleID, "2026-08-11T12:00:00Z", "2026-08-11T12:00:00Z"); err != nil {
		t.Fatalf("add statistics permission: %v", err)
	}

	readDashboard := func() (finance.Dashboard, string) {
		t.Helper()
		request := roleHandlerRequest(principal, administrator.GroupID, http.MethodGet, "")
		response := httptest.NewRecorder()
		server.handleDashboard(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("dashboard status=%d body=%s", response.Code, response.Body.String())
		}
		var dashboard finance.Dashboard
		if err := json.Unmarshal(response.Body.Bytes(), &dashboard); err != nil {
			t.Fatalf("decode dashboard: %v", err)
		}
		return dashboard, response.Body.String()
	}

	dashboard, body := readDashboard()
	if dashboard.GroupOutstanding == nil || *dashboard.GroupOutstanding != -150 {
		t.Fatalf("statistics-only dashboard outstanding=%v body=%s", dashboard.GroupOutstanding, body)
	}

	if _, err := server.db.Exec(`DELETE FROM role_permission_grants WHERE group_id=? AND role_id=? AND permission_key='VIEW_GROUP_STATISTICS'`, administrator.GroupID, administratorRoleID); err != nil {
		t.Fatalf("remove group-statistics permission: %v", err)
	}
	dashboard, body = readDashboard()
	if dashboard.GroupOutstanding != nil {
		t.Fatalf("unauthorized dashboard outstanding=%d body=%s", *dashboard.GroupOutstanding, body)
	}
	if json.Valid([]byte(body)) && containsJSONField(body, "groupOutstandingMinor") {
		t.Fatalf("unauthorized dashboard exposed groupOutstandingMinor: %s", body)
	}
}

func containsJSONField(document, field string) bool {
	var value map[string]any
	if err := json.Unmarshal([]byte(document), &value); err != nil {
		return false
	}
	_, exists := value[field]
	return exists
}
