package httpapi

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/activities"
	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/config"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/exporting"
	exportingtabular "github.com/DasLukas/TeamTaler/internal/exporting/tabular"
	"github.com/DasLukas/TeamTaler/internal/exportnotifications"
	"github.com/DasLukas/TeamTaler/internal/finance"
	"github.com/DasLukas/TeamTaler/internal/media"
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

	deleteRequest := authenticatedJSONRequest(http.MethodDelete, "/api/v1/exports/"+queued.ID, "", principal)
	deleteRequest.SetPathValue("exportID", queued.ID)
	deleteResponse := httptest.NewRecorder()
	server.handleDeleteDataExport(deleteResponse, deleteRequest)
	if deleteResponse.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d body=%s", deleteResponse.Code, deleteResponse.Body.String())
	}
	deletedListResponse := httptest.NewRecorder()
	server.handleListDataExports(deletedListResponse, listRequest)
	if err := json.Unmarshal(deletedListResponse.Body.Bytes(), &jobs); err != nil || deletedListResponse.Code != http.StatusOK || len(jobs) != 0 {
		t.Fatalf("list after delete status=%d jobs=%#v err=%v body=%s", deletedListResponse.Code, jobs, err, deletedListResponse.Body.String())
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

func TestPDFTableRowsEmbedManagedMemberImagesAndActivityTones(t *testing.T) {
	server, _, membership := invitationImportServer(t, false)
	server.config = config.Config{DataDirectory: t.TempDir()}
	imageKey := storeTableExportFixtureImage(t, server.config.DataDirectory)
	if _, err := server.db.Exec(`UPDATE users SET avatar_key=? WHERE id=?`, imageKey, membership.UserID); err != nil {
		t.Fatalf("attach member fixture: %v", err)
	}

	_, pdfRows, err := server.memberExportRows(context.Background(), membership, json.RawMessage(`{}`), true, 100, true)
	if err != nil {
		t.Fatalf("build PDF member rows: %v", err)
	}
	if len(pdfRows) == 0 || len(pdfRows[0].Cells[0].ImagePNG) == 0 {
		t.Fatal("PDF member rows did not embed the managed avatar")
	}
	_, csvRows, err := server.memberExportRows(context.Background(), membership, json.RawMessage(`{}`), true, 100, false)
	if err != nil {
		t.Fatalf("build CSV member rows: %v", err)
	}
	if len(csvRows) == 0 || len(csvRows[0].Cells[0].ImagePNG) != 0 {
		t.Fatal("CSV member rows unexpectedly loaded PDF-only media")
	}
	if !csvRows[0].Cells[0].ImageSlot {
		t.Fatal("image-capable member cell did not reserve a stable alignment slot")
	}
	if got := activityKindCell(activities.KindBooking, true).Tone; got != exportingtabular.ToneWarning {
		t.Fatalf("booking tone = %v, want %v", got, exportingtabular.ToneWarning)
	}
	if got := activityKindCell(activities.KindPayment, true).Tone; got != exportingtabular.ToneSuccess {
		t.Fatalf("payment tone = %v, want %v", got, exportingtabular.ToneSuccess)
	}
	if got := activityMoneyCell(-1250, "EUR", activities.KindPayment, true).Tone; got != exportingtabular.ToneSuccess {
		t.Fatalf("payment amount tone = %v, want %v", got, exportingtabular.ToneSuccess)
	}
	if got := balanceTone(1250); got != exportingtabular.ToneDanger {
		t.Fatalf("open balance tone = %v, want %v", got, exportingtabular.ToneDanger)
	}
	if got := balanceTone(0); got != exportingtabular.ToneSuccess {
		t.Fatalf("settled balance tone = %v, want %v", got, exportingtabular.ToneSuccess)
	}
	if got := balanceTone(-1250); got != exportingtabular.ToneSuccess {
		t.Fatalf("credit balance tone = %v, want %v", got, exportingtabular.ToneSuccess)
	}
	if got := settlementTone("PARTIAL"); got != exportingtabular.ToneWarning {
		t.Fatalf("partial settlement tone = %v, want %v", got, exportingtabular.ToneWarning)
	}
	if got := transactionTone("REVERSED"); got != exportingtabular.ToneDanger {
		t.Fatalf("reversed payment tone = %v, want %v", got, exportingtabular.ToneDanger)
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
		{`INSERT INTO memberships(id,group_id,user_id,status,joined_at,archived_at) VALUES(?,?,?,'ARCHIVED',?,?)`, []any{guestMembershipID, membership.GroupID, guestUserID, timestamp, timestamp}},
		{`INSERT INTO periods(id,group_id,label,status,starts_at,closed_at,due_at,created_at) VALUES(?,?,'August 2026','CLOSED',?,?,?,?)`, []any{periodID, membership.GroupID, timestamp, timestamp, "2026-09-10", timestamp}},
		{`INSERT INTO period_statements(id,group_id,period_id,membership_id,display_name,email,charges_minor,payments_allocated_minor,amount_due_minor,status,created_at) VALUES('stmt_export_admin',?,?,?,'Admin','admin@example.test',1200,0,1200,'OPEN',?)`, []any{membership.GroupID, periodID, membership.ID, timestamp}},
		{`INSERT INTO period_statements(id,group_id,period_id,membership_id,display_name,email,charges_minor,payments_allocated_minor,amount_due_minor,status,created_at) VALUES('stmt_export_guest',?,?,?,'Guest Export','guest-export@example.test',3400,0,3400,'OPEN',?)`, []any{membership.GroupID, periodID, guestMembershipID, timestamp}},
	}
	for _, statement := range statements {
		if _, err := server.db.Exec(statement.query, statement.args...); err != nil {
			t.Fatalf("prepare export fixture: %v", err)
		}
	}
	if _, err := server.db.Exec(`INSERT OR IGNORE INTO membership_role_assignments(group_id,membership_id,role_id,assigned_at,assigned_by) VALUES(?,?,?,?,?)`, membership.GroupID, membership.ID, authorization.TemplateRoleID(membership.GroupID, domain.RoleTemplateFinance), timestamp, membership.ID); err != nil {
		t.Fatalf("grant finance role for group settlement export: %v", err)
	}

	personalColumns, personalRows, err := server.settlementExportRows(context.Background(), membership, json.RawMessage(`{}`), true, 100, false)
	if err != nil {
		t.Fatalf("personal settlement export: %v", err)
	}
	if len(personalRows) != 1 {
		t.Fatalf("personal settlement rows = %d, want only the actor's row", len(personalRows))
	}
	if got := columnIDs(personalColumns); !slicesEqual(got, []string{"period", "due_at", "amount", "paid", "open", "status"}) {
		t.Fatalf("personal settlement columns = %v", got)
	}

	groupColumns, _, err := server.settlementExportRows(context.Background(), membership, json.RawMessage(`{}`), false, 100, false)
	if err != nil {
		t.Fatalf("group settlement export: %v", err)
	}
	if got := columnIDs(groupColumns); !slicesEqual(got, []string{"period", "member", "membership_status", "due_at", "amount", "paid", "status"}) {
		t.Fatalf("group settlement columns = %v", got)
	}
	_, decoratedGroupRows, err := server.settlementExportRows(context.Background(), membership, json.RawMessage(`{}`), false, 100, true)
	if err != nil {
		t.Fatalf("decorated group settlement export: %v", err)
	}
	for rowIndex, row := range decoratedGroupRows {
		if got := row.Cells[4].Tone; got != exportingtabular.ToneDanger {
			t.Fatalf("group settlement row %d claim tone = %q, want danger", rowIndex, got)
		}
		if got := row.Cells[5].Tone; got != exportingtabular.ToneSuccess {
			t.Fatalf("group settlement row %d paid tone = %q, want success for zero payment", rowIndex, got)
		}
	}
	statusTones := map[string]exportingtabular.CellTone{}
	for _, row := range decoratedGroupRows {
		statusTones[row.Cells[1].Text] = row.Cells[2].Tone
	}
	if got := statusTones["Admin"]; got != exportingtabular.ToneSuccess {
		t.Fatalf("active membership tone = %q, want success", got)
	}
	if got := statusTones["Guest Export"]; got != exportingtabular.ToneWarning {
		t.Fatalf("archived membership tone = %q, want warning", got)
	}
	_, archivedRows, err := server.settlementExportRows(context.Background(), membership, json.RawMessage(`{"membershipStatus":["ARCHIVED"]}`), false, 100, false)
	if err != nil {
		t.Fatalf("filtered group settlement export: %v", err)
	}
	if len(archivedRows) != 1 || archivedRows[0].Cells[1].Text != "Guest Export" {
		t.Fatalf("archived settlement rows = %#v, want Guest Export", archivedRows)
	}
	_, exactRows, err := server.settlementExportRows(context.Background(), membership, json.RawMessage(`{"periodId":"`+periodID+`","membershipId":"`+guestMembershipID+`"}`), false, 100, false)
	if err != nil {
		t.Fatalf("exact settlement row export: %v", err)
	}
	if len(exactRows) != 1 || exactRows[0].Cells[1].Text != "Guest Export" {
		t.Fatalf("exact settlement rows = %#v, want only Guest Export", exactRows)
	}

	archivedColumns, _, err := server.memberExportRows(context.Background(), membership, json.RawMessage(`{}`), false, 100, false)
	if err != nil {
		t.Fatalf("archived member export: %v", err)
	}
	if got := columnIDs(archivedColumns); !slicesEqual(got, []string{"member", "email"}) {
		t.Fatalf("archived member columns = %v", got)
	}
}

func TestSettlementStatementExportContainsExactBookingLinesAndDetailedHeader(t *testing.T) {
	server, _, membership := invitationImportServer(t, false)
	server.config = config.Config{DataDirectory: t.TempDir()}
	imageKey := storeTableExportFixtureImage(t, server.config.DataDirectory)
	const (
		guestUserID       = "usr_statement_guest"
		guestMembershipID = "mem_statement_guest"
		periodID          = "per_statement_closed"
		categoryID        = "cat_statement"
		productID         = "prd_statement"
		timestamp         = "2026-08-25T10:00:00Z"
	)
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users(id,email,display_name,password_hash,avatar_key,created_at,updated_at) VALUES(?,NULL,'Marie Mitglied',NULL,?,?,?)`, []any{guestUserID, imageKey, timestamp, timestamp}},
		{`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES(?,?,?,'ARCHIVED',?)`, []any{guestMembershipID, membership.GroupID, guestUserID, timestamp}},
		{`INSERT INTO periods(id,group_id,label,status,starts_at,closed_at,due_at,created_at) VALUES(?,?,'August 2026','CLOSED',?,?,?,?)`, []any{periodID, membership.GroupID, timestamp, timestamp, "2026-09-10", timestamp}},
		{`INSERT INTO period_statements(id,group_id,period_id,membership_id,display_name,email,charges_minor,payments_allocated_minor,amount_due_minor,status,created_at) VALUES('stmt_booking_detail',?,?,?,'Marie Mitglied',NULL,500,0,500,'OPEN',?)`, []any{membership.GroupID, periodID, guestMembershipID, timestamp}},
		{`INSERT INTO categories(id,group_id,name,active,sort_order,created_at,updated_at) VALUES(?,?,'Getränke',1,0,?,?)`, []any{categoryID, membership.GroupID, timestamp, timestamp}},
		{`INSERT INTO products(id,group_id,category_id,name,price_minor,image_key,active,sort_order,version,created_at,updated_at) VALUES(?,?,?,'Mineralwasser',250,?,1,0,1,?,?)`, []any{productID, membership.GroupID, categoryID, imageKey, timestamp, timestamp}},
		{`INSERT INTO bookings(id,group_id,period_id,category_id,product_id,actor_membership_id,target_membership_id,quantity,unit_price_minor,total_minor,product_name,category_name,reason,created_at) VALUES('bok_statement_exact',?,?,?,?,?,?,2,250,500,'Mineralwasser','Getränke','Mannschaftsabend',?)`, []any{membership.GroupID, periodID, categoryID, productID, membership.ID, guestMembershipID, timestamp}},
		{`INSERT INTO bookings(id,group_id,period_id,category_id,product_id,actor_membership_id,target_membership_id,quantity,unit_price_minor,total_minor,product_name,category_name,reason,created_at) VALUES('bok_statement_other_member',?,?,?,?,?,?,1,250,250,'Mineralwasser','Getränke','Andere Person',?)`, []any{membership.GroupID, periodID, categoryID, productID, membership.ID, membership.ID, timestamp}},
	}
	for _, statement := range statements {
		if _, err := server.db.Exec(statement.query, statement.args...); err != nil {
			t.Fatalf("prepare statement detail fixture: %v", err)
		}
	}
	if _, err := server.db.Exec(`UPDATE users SET avatar_key=? WHERE id=?`, imageKey, membership.UserID); err != nil {
		t.Fatalf("attach actor fixture: %v", err)
	}
	if _, err := server.db.Exec(`INSERT OR IGNORE INTO membership_role_assignments(group_id,membership_id,role_id,assigned_at,assigned_by) VALUES(?,?,?,?,?)`, membership.GroupID, membership.ID, authorization.TemplateRoleID(membership.GroupID, domain.RoleTemplateFinance), timestamp, membership.ID); err != nil {
		t.Fatalf("grant finance role for statement detail export: %v", err)
	}

	document, err := server.buildGroupTableDocument(context.Background(), membership,
		tableExportCommand{Table: "SETTLEMENT_STATEMENT", Format: "PDF", TimeZone: "Europe/Berlin", Query: json.RawMessage(`{"periodId":"` + periodID + `","membershipId":"` + guestMembershipID + `"}`)},
		tableExportDefinitions["SETTLEMENT_STATEMENT"], time.FixedZone("CEST", 2*60*60), tableExportPDFRowLimit)
	if err != nil {
		t.Fatalf("build statement detail export: %v", err)
	}
	if document.Title != "Abgeschlossene Abrechnung" || document.Subtitle != "August 2026" || document.SubjectName != "Marie Mitglied" {
		t.Fatalf("statement header = %q / %q / %q", document.Title, document.Subtitle, document.SubjectName)
	}
	if len(document.SubjectImagePNG) == 0 {
		t.Fatal("statement header did not include the member avatar")
	}
	if got := columnIDs(document.Columns); !slicesEqual(got, []string{"kind", "actor", "details", "category", "occurred_at", "amount", "status"}) {
		t.Fatalf("statement detail columns = %v", got)
	}
	if len(document.Rows) != 1 {
		t.Fatalf("statement booking rows = %d, want only the exact member and period", len(document.Rows))
	}
	row := document.Rows[0]
	if row.Cells[2].Text != "Mineralwasser × 2\nMannschaftsabend" || len(row.Cells[1].ImagePNG) == 0 || len(row.Cells[2].ImagePNG) == 0 {
		t.Fatalf("statement booking detail row = %#v", row)
	}
	if row.Cells[0].Tone != exportingtabular.ToneWarning || row.Cells[5].Tone != exportingtabular.ToneWarning {
		t.Fatalf("statement booking tones = %v / %v, want warning", row.Cells[0].Tone, row.Cells[5].Tone)
	}
	if _, err := server.settlementStatementExportContent(context.Background(), membership, json.RawMessage(`{"periodId":"`+periodID+`","membershipId":"`+guestMembershipID+`","unexpected":true}`), time.UTC, 100, false); err == nil {
		t.Fatal("statement detail export accepted an unsupported query field")
	}
}

func TestTableExportNaturalGermanOrdering(t *testing.T) {
	if compareText("Mitglied 2", "Mitglied 10") >= 0 {
		t.Fatal("natural ordering did not place Mitglied 2 before Mitglied 10")
	}
	if compareText("Änne", "Zora") >= 0 {
		t.Fatal("German collation did not place Änne before Zora")
	}
	if got, want := tableArtifactFilename("Aktivitäten", "PDF", "pdf", time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)), "2026-08-26_Aktivitäten.pdf"; got != want {
		t.Fatalf("PDF artifact filename = %q, want %q", got, want)
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

func storeTableExportFixtureImage(t *testing.T, dataDirectory string) string {
	t.Helper()
	canvas := image.NewRGBA(image.Rect(0, 0, 24, 24))
	for y := 0; y < 24; y++ {
		for x := 0; x < 24; x++ {
			canvas.SetRGBA(x, y, color.RGBA{R: 16, G: 142, B: 124, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, canvas); err != nil {
		t.Fatalf("encode table export fixture image: %v", err)
	}
	imageKey, _, err := media.NormalizeAndStoreImage(dataDirectory, bytes.NewReader(encoded.Bytes()))
	if err != nil {
		t.Fatalf("store table export fixture image: %v", err)
	}
	return imageKey
}
