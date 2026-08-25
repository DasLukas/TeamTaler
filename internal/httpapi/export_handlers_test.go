package httpapi

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/activities"
	"github.com/DasLukas/TeamTaler/internal/config"
	"github.com/DasLukas/TeamTaler/internal/exporting"
	exportingtabular "github.com/DasLukas/TeamTaler/internal/exporting/tabular"
	"github.com/DasLukas/TeamTaler/internal/exportnotifications"
	"github.com/DasLukas/TeamTaler/internal/finance"
	"github.com/DasLukas/TeamTaler/internal/periods"
	systemadmin "github.com/DasLukas/TeamTaler/internal/system"
)

func TestRawDataExportHandlersCreateProcessListAndDownload(t *testing.T) {
	server, principal, membership := invitationImportServer(t, false)
	store, err := exporting.NewFileArtifactStore(filepath.Join(t.TempDir(), "exports"))
	if err != nil {
		t.Fatalf("create artifact store: %v", err)
	}
	server.exports, err = exporting.NewService(server.db, store, exporting.Options{CompletionListener: exportnotifications.Listener{DB: server.db}})
	if err != nil {
		t.Fatalf("create export service: %v", err)
	}
	server.passwordSlots = make(chan struct{}, 2)
	server.logger = slog.New(slog.NewTextHandler(io.Discard, nil))

	request := authenticatedJSONRequest(http.MethodPost, "/api/v1/groups/"+membership.GroupID+"/exports", `{"currentPassword":"correct-horse-battery-staple"}`, principal)
	request.SetPathValue("groupID", membership.GroupID)
	request.Header.Set("Idempotency-Key", "raw-handler-export-0001")
	response := httptest.NewRecorder()
	server.handleCreateGroupDataExport(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("create status=%d body=%s", response.Code, response.Body.String())
	}
	var queued exporting.Job
	if err := json.Unmarshal(response.Body.Bytes(), &queued); err != nil || queued.Status != exporting.StatusQueued || queued.Scope != exporting.ScopeGroup {
		t.Fatalf("queued job=%#v err=%v", queued, err)
	}
	completed, err := server.exports.ProcessNext(context.Background())
	if err != nil || completed.Status != exporting.StatusReady {
		t.Fatalf("completed job=%#v err=%v", completed, err)
	}

	listRequest := authenticatedJSONRequest(http.MethodGet, "/api/v1/exports?groupId="+membership.GroupID, "", principal)
	listResponse := httptest.NewRecorder()
	server.handleListDataExports(listResponse, listRequest)
	var jobs []exporting.Job
	if err := json.Unmarshal(listResponse.Body.Bytes(), &jobs); err != nil || listResponse.Code != http.StatusOK || len(jobs) != 1 || jobs[0].Status != exporting.StatusReady {
		t.Fatalf("list status=%d jobs=%#v err=%v body=%s", listResponse.Code, jobs, err, listResponse.Body.String())
	}

	downloadRequest := authenticatedJSONRequest(http.MethodGet, "/api/v1/exports/"+queued.ID+"/download", "", principal)
	downloadRequest.SetPathValue("exportID", queued.ID)
	downloadResponse := httptest.NewRecorder()
	server.handleDownloadDataExport(downloadResponse, downloadRequest)
	if downloadResponse.Code != http.StatusOK || downloadResponse.Header().Get("Content-Type") != "application/zip" || !bytes.HasPrefix(downloadResponse.Body.Bytes(), []byte("PK")) || downloadResponse.Header().Get("X-Content-SHA256") == "" {
		t.Fatalf("download status=%d headers=%v prefix=%q", downloadResponse.Code, downloadResponse.Header(), downloadResponse.Body.Bytes()[:min(8, downloadResponse.Body.Len())])
	}

	badRequest := authenticatedJSONRequest(http.MethodPost, "/api/v1/groups/"+membership.GroupID+"/me/exports", `{"currentPassword":"incorrect-password"}`, principal)
	badRequest.SetPathValue("groupID", membership.GroupID)
	badRequest.Header.Set("Idempotency-Key", "raw-handler-export-0002")
	badResponse := httptest.NewRecorder()
	server.handleCreatePersonalDataExport(badResponse, badRequest)
	if badResponse.Code != http.StatusUnauthorized {
		t.Fatalf("bad password status=%d body=%s", badResponse.Code, badResponse.Body.String())
	}
}

func TestGroupTableExportCSVUsesCanonicalServerColumnsAndRecordsAudit(t *testing.T) {
	server, principal, membership := invitationImportServer(t, false)
	server.logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	server.config = config.Config{DataDirectory: t.TempDir()}
	server.activities = activities.Service{DB: server.db}
	server.finance = finance.Service{DB: server.db}
	server.periods = periods.Service{DB: server.db}

	body := `{"table":"ACTIVITIES","format":"CSV","timeZone":"Europe/Berlin","query":{"sort":"occurredAt","direction":"desc"}}`
	request := authenticatedJSONRequest(http.MethodPost, "/api/v1/groups/"+membership.GroupID+"/table-exports", body, principal)
	request.SetPathValue("groupID", membership.GroupID)
	response := httptest.NewRecorder()
	server.handleGroupTableExport(response, request)
	if response.Code != http.StatusOK || !strings.HasPrefix(response.Header().Get("Content-Type"), "text/csv") || response.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("CSV status=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
	content := bytes.TrimPrefix(response.Body.Bytes(), []byte{0xEF, 0xBB, 0xBF})
	reader := csv.NewReader(bytes.NewReader(content))
	reader.Comma = ';'
	headers, err := reader.Read()
	if err != nil || !slicesEqual(headers, []string{"Vorgang", "Mitglied", "Erfasst von", "Details", "Kategorie", "Zeitpunkt", "Betrag", "Status"}) {
		t.Fatalf("CSV headers=%#v err=%v", headers, err)
	}
	var auditCount int
	if err := server.db.QueryRow(`SELECT count(*) FROM audit_events WHERE group_id=? AND action='table.exported' AND resource_id='activities'`, membership.GroupID).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatalf("table export audit count=%d err=%v", auditCount, err)
	}
	document, err := server.buildGroupTableDocument(context.Background(), membership,
		tableExportCommand{Table: "ACTIVITIES", Format: "PDF", TimeZone: "Europe/Berlin", Query: json.RawMessage(`{"sort":"occurredAt","direction":"desc"}`)},
		tableExportDefinitions["ACTIVITIES"], time.FixedZone("CEST", 2*60*60), tableExportPDFRowLimit)
	if err != nil || document.GroupName != "Import Team" {
		t.Fatalf("group export branding = %q, %v", document.GroupName, err)
	}
}

func TestSettlementAndMemberExportsMatchVisibleColumnAndPrivacyBoundaries(t *testing.T) {
	server, _, membership := invitationImportServer(t, false)
	server.periods = periods.Service{DB: server.db}
	const (
		guestUserID       = "usr_export_guest"
		guestMembershipID = "mem_export_guest"
		periodID          = "per_export_closed"
		timestamp         = "2026-08-25T10:00:00Z"
	)
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES(?,NULL,'Guest Export',NULL,?,?)`, []any{guestUserID, timestamp, timestamp}},
		{`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES(?,?,?,'ACTIVE',?)`, []any{guestMembershipID, membership.GroupID, guestUserID, timestamp}},
		{`INSERT INTO periods(id,group_id,label,status,starts_at,closed_at,due_at,created_at) VALUES(?,?,'August 2026','CLOSED',?,?,?,?)`, []any{periodID, membership.GroupID, timestamp, timestamp, "2026-09-10", timestamp}},
		{`INSERT INTO period_statements(id,group_id,period_id,membership_id,display_name,email,charges_minor,payments_allocated_minor,amount_due_minor,status,created_at) VALUES('stmt_export_admin',?,?,?,'Admin','admin@example.test',1200,0,1200,'OPEN',?)`, []any{membership.GroupID, periodID, membership.ID, timestamp}},
		{`INSERT INTO period_statements(id,group_id,period_id,membership_id,display_name,email,charges_minor,payments_allocated_minor,amount_due_minor,status,created_at) VALUES('stmt_export_guest',?,?,?,'Guest Export','guest-export@example.test',3400,0,3400,'OPEN',?)`, []any{membership.GroupID, periodID, guestMembershipID, timestamp}},
	}
	for _, statement := range statements {
		if _, err := server.db.Exec(statement.query, statement.args...); err != nil {
			t.Fatalf("prepare export fixture: %v", err)
		}
	}

	personalColumns, personalRows, err := server.settlementExportRows(context.Background(), membership, json.RawMessage(`{}`), true, 100)
	if err != nil {
		t.Fatalf("personal settlement export: %v", err)
	}
	if len(personalRows) != 1 {
		t.Fatalf("personal settlement rows = %d, want only the actor's row", len(personalRows))
	}
	if got := columnIDs(personalColumns); !slicesEqual(got, []string{"period", "due_at", "amount", "paid", "open", "status"}) {
		t.Fatalf("personal settlement columns = %v", got)
	}

	groupColumns, _, err := server.settlementExportRows(context.Background(), membership, json.RawMessage(`{}`), false, 100)
	if err != nil {
		t.Fatalf("group settlement export: %v", err)
	}
	if got := columnIDs(groupColumns); !slicesEqual(got, []string{"period", "member", "due_at", "amount", "paid", "status"}) {
		t.Fatalf("group settlement columns = %v", got)
	}

	archivedColumns, _, err := server.memberExportRows(context.Background(), membership, json.RawMessage(`{}`), false, 100)
	if err != nil {
		t.Fatalf("archived member export: %v", err)
	}
	if got := columnIDs(archivedColumns); !slicesEqual(got, []string{"member", "email"}) {
		t.Fatalf("archived member columns = %v", got)
	}
}

func TestTableExportNaturalGermanOrdering(t *testing.T) {
	if compareText("Mitglied 2", "Mitglied 10") >= 0 {
		t.Fatal("natural ordering did not place Mitglied 2 before Mitglied 10")
	}
	if compareText("Änne", "Zora") >= 0 {
		t.Fatal("German collation did not place Änne before Zora")
	}
}

func TestTableExportRejectsClientOwnedSchemaAndCrossScopeTables(t *testing.T) {
	server, principal, membership := invitationImportServer(t, false)
	server.logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	server.config = config.Config{DataDirectory: t.TempDir()}

	tests := []struct {
		name string
		body string
	}{
		{name: "client title", body: `{"table":"ACTIVITIES","format":"CSV","timeZone":"UTC","query":{},"title":"Injected"}`},
		{name: "system table in group", body: `{"table":"SYSTEM_AUDIT","format":"CSV","timeZone":"UTC","query":{}}`},
		{name: "unknown nested query", body: `{"table":"ACTIVE_MEMBERS","format":"CSV","timeZone":"UTC","query":{"rows":[{"secret":"value"}]}}`},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			request := authenticatedJSONRequest(http.MethodPost, "/api/v1/groups/"+membership.GroupID+"/table-exports", testCase.body, principal)
			request.SetPathValue("groupID", membership.GroupID)
			response := httptest.NewRecorder()
			server.handleGroupTableExport(response, request)
			if response.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestSystemAuditTableExportProducesPDFForSystemAdministrator(t *testing.T) {
	server, principal, _ := invitationImportServer(t, false)
	server.logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	service, err := systemadmin.NewService(server.db, systemadmin.Defaults{
		InstanceName: "TeamTaler", DefaultCurrency: "EUR", MediaUploadMaxBytes: 5 << 20,
		PublicJoinEnabled: true, MaxRequestBytes: 6 << 20, Sources: map[systemadmin.SettingKey]systemadmin.SettingSource{},
	}, nil)
	if err != nil {
		t.Fatalf("create system service: %v", err)
	}
	server.systemAdmin = service
	if _, err := server.db.Exec(`INSERT OR IGNORE INTO system_role_assignments(user_id,role,granted_at) VALUES(?,'SYSTEM_ADMINISTRATOR','2026-08-25T10:00:00Z')`, principal.UserID); err != nil {
		t.Fatalf("grant system administrator: %v", err)
	}
	if _, err := server.db.Exec(`INSERT INTO system_audit_events(id,actor_user_id,action,resource_type,resource_id,metadata_json,occurred_at) VALUES('sya_export_fixture',?,'system.export.fixture','fixture','one','{}','2026-08-25T10:15:00Z')`, principal.UserID); err != nil {
		t.Fatalf("insert system audit fixture: %v", err)
	}

	request := authenticatedJSONRequest(http.MethodPost, "/api/v1/system/table-exports", `{"table":"SYSTEM_AUDIT","format":"PDF","timeZone":"Europe/Berlin","query":{"sort":"occurredAt","direction":"desc"}}`, principal)
	response := httptest.NewRecorder()
	server.handleSystemTableExport(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "application/pdf" || !bytes.HasPrefix(response.Body.Bytes(), []byte("%PDF-")) {
		t.Fatalf("PDF status=%d headers=%v prefix=%q body=%s", response.Code, response.Header(), response.Body.Bytes()[:min(8, response.Body.Len())], response.Body.String())
	}
	var auditCount int
	if err := server.db.QueryRow(`SELECT count(*) FROM system_audit_events WHERE action='table.exported' AND resource_id='system_audit'`).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatalf("system table export audit count=%d err=%v", auditCount, err)
	}
}

func slicesEqual(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func columnIDs(columns []exportingtabular.Column) []string {
	result := make([]string, len(columns))
	for index, column := range columns {
		result[index] = column.ID
	}
	return result
}
