package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/bookings"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/finance"
	"github.com/DasLukas/TeamTaler/internal/periods"
	"github.com/DasLukas/TeamTaler/internal/platform"
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

func TestDashboardIncludesInProgressAllDayEvent(t *testing.T) {
	server, principal, administrator := invitationImportServer(t, false)
	server.finance = finance.Service{DB: server.db}
	server.bookings = bookings.Service{DB: server.db}
	server.periods = periods.Service{DB: server.db}

	location, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("load timezone: %v", err)
	}
	localNow := time.Now().In(location)
	startDate := localNow.Format("2006-01-02")
	endDate := localNow.AddDate(0, 0, 1).Format("2006-01-02")
	start := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, location).UTC()
	end := start.In(location).AddDate(0, 0, 1).UTC()
	now := platform.Timestamp(time.Now())
	if _, err := server.db.Exec(`UPDATE group_planning_settings SET enabled=1,updated_at=? WHERE group_id=?`, now, administrator.GroupID); err != nil {
		t.Fatalf("enable planning: %v", err)
	}
	if _, err := server.db.Exec(`INSERT INTO planning_events(
		id,group_id,title,event_type,status,audience_type,all_day,timezone,start_date,end_date_exclusive,starts_at,ends_at,
		version,created_by_membership_id,updated_by_membership_id,published_at,created_at,updated_at
	) VALUES('event-dashboard-all-day',?,'Current all-day event','APPOINTMENT','PUBLISHED','ALL_ACTIVE_MEMBERS',1,?,?,?,?,?,2,?,?,?,?,?)`,
		administrator.GroupID, location.String(), startDate, endDate, platform.Timestamp(start), platform.Timestamp(end), administrator.ID, administrator.ID, now, now, now); err != nil {
		t.Fatalf("insert all-day event: %v", err)
	}
	if _, err := server.db.Exec(`INSERT INTO planning_event_audience(group_id,event_id,membership_id,display_name_snapshot,invited_at) VALUES(?,'event-dashboard-all-day',?,'Administrator',?)`, administrator.GroupID, administrator.ID, now); err != nil {
		t.Fatalf("insert all-day audience: %v", err)
	}
	if _, err := server.db.Exec(`UPDATE planning_events SET description='Dashboard agenda description',location='Club house' WHERE id='event-dashboard-all-day'`); err != nil {
		t.Fatalf("add dashboard presentation fields: %v", err)
	}
	if _, err := server.db.Exec(`INSERT INTO planning_events(
		id,group_id,title,event_type,status,audience_type,all_day,timezone,start_date,end_date_exclusive,starts_at,ends_at,
		version,created_by_membership_id,updated_by_membership_id,published_at,created_at,updated_at
	) VALUES('event-dashboard-poll',?,'Current all-day poll','APPOINTMENT_POLL','PUBLISHED','ALL_ACTIVE_MEMBERS',1,?,?,?,?,?,2,?,?,?,?,?)`,
		administrator.GroupID, location.String(), startDate, endDate, platform.Timestamp(start), platform.Timestamp(end), administrator.ID, administrator.ID, now, now, now); err != nil {
		t.Fatalf("insert all-day poll without deadline: %v", err)
	}
	if _, err := server.db.Exec(`INSERT INTO planning_event_audience(group_id,event_id,membership_id,display_name_snapshot,invited_at) VALUES(?,'event-dashboard-poll',?,'Administrator',?)`, administrator.GroupID, administrator.ID, now); err != nil {
		t.Fatalf("insert all-day poll audience: %v", err)
	}

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
	if dashboard.NextPlanningEvent == nil || dashboard.NextPlanningEvent.ID != "event-dashboard-all-day" {
		t.Fatalf("next planning event=%#v, want current all-day event", dashboard.NextPlanningEvent)
	}
	if !dashboard.NextPlanningEvent.AllDay || dashboard.NextPlanningEvent.TimeZone != location.String() || dashboard.NextPlanningEvent.StartDate != startDate || dashboard.NextPlanningEvent.EndDateExclusive != endDate {
		t.Fatalf("all-day dashboard projection=%#v", dashboard.NextPlanningEvent)
	}
	if dashboard.NextPlanningEvent.EndsAt != platform.Timestamp(end) {
		t.Fatalf("dashboard event end=%q, want %q", dashboard.NextPlanningEvent.EndsAt, platform.Timestamp(end))
	}
	if dashboard.NextPlanningEvent.Description != "Dashboard agenda description" || dashboard.NextPlanningEvent.Location != "Club house" {
		t.Fatalf("dashboard presentation fields=%#v", dashboard.NextPlanningEvent)
	}
	if dashboard.NextPlanningEvent.Counts.Invited != 1 {
		t.Fatalf("dashboard participation counts=%#v, want one invited member", dashboard.NextPlanningEvent.Counts)
	}
	if dashboard.OpenPlanningActionCount != 1 {
		t.Fatalf("open planning actions=%d, want deadline-free poll before its exclusive end", dashboard.OpenPlanningActionCount)
	}
}

func TestDashboardOrdersFractionalPlanningStartsNumerically(t *testing.T) {
	server, principal, administrator := invitationImportServer(t, false)
	server.finance = finance.Service{DB: server.db}
	server.bookings = bookings.Service{DB: server.db}
	server.periods = periods.Service{DB: server.db}
	now := platform.Timestamp(platform.Now())
	if _, err := server.db.Exec(`UPDATE group_planning_settings SET enabled=1,updated_at=? WHERE group_id=?`, now, administrator.GroupID); err != nil {
		t.Fatal(err)
	}
	base := platform.Now().Add(time.Hour).Truncate(time.Second)
	for _, event := range []struct {
		id, title, startsAt string
	}{
		{id: "dashboard-fraction-first", title: "First exact second", startsAt: platform.Timestamp(base)},
		{id: "dashboard-fraction-later", title: "Later fractional second", startsAt: platform.Timestamp(base.Add(900 * time.Millisecond))},
	} {
		if _, err := server.db.Exec(`INSERT INTO planning_events(
			id,group_id,title,event_type,status,audience_type,timezone,starts_at,
			version,created_by_membership_id,updated_by_membership_id,published_at,created_at,updated_at
		) VALUES(?,?,?,?,?,'ALL_ACTIVE_MEMBERS','Europe/Berlin',?,1,?,?,?,?,?)`,
			event.id, administrator.GroupID, event.title, "APPOINTMENT", "PUBLISHED", event.startsAt,
			administrator.ID, administrator.ID, now, now, now); err != nil {
			t.Fatalf("insert %s: %v", event.id, err)
		}
		if _, err := server.db.Exec(`INSERT INTO planning_event_audience(group_id,event_id,membership_id,display_name_snapshot,invited_at) VALUES(?,?,?,?,?)`, administrator.GroupID, event.id, administrator.ID, "Administrator", now); err != nil {
			t.Fatalf("insert %s audience: %v", event.id, err)
		}
	}

	request := roleHandlerRequest(principal, administrator.GroupID, http.MethodGet, "")
	response := httptest.NewRecorder()
	server.handleDashboard(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("dashboard status=%d body=%s", response.Code, response.Body.String())
	}
	var dashboard finance.Dashboard
	if err := json.Unmarshal(response.Body.Bytes(), &dashboard); err != nil {
		t.Fatal(err)
	}
	if dashboard.NextPlanningEvent == nil || dashboard.NextPlanningEvent.ID != "dashboard-fraction-first" {
		t.Fatalf("next planning event=%#v", dashboard.NextPlanningEvent)
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
