package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/externalaccounts"
)

func TestExternalAccountHandlersFeaturePreconditionsIdempotencyAndRedaction(t *testing.T) {
	server, principal, administrator := invitationImportServer(t, false)
	server.externalAccounts = externalaccounts.Service{DB: server.db}
	if _, err := server.db.Exec(`INSERT OR IGNORE INTO role_permission_grants(group_id,role_id,permission_key,scope_type,version,created_at,updated_at)
		SELECT ?,role_id,?,'GROUP',1,'2026-09-13T10:00:00Z','2026-09-13T10:00:00Z' FROM membership_role_assignments WHERE group_id=? AND membership_id=?`, administrator.GroupID, "MANAGE_EXTERNAL_ACCOUNTS", administrator.GroupID, administrator.ID); err != nil {
		t.Fatal(err)
	}

	disabled := roleHandlerRequest(principal, administrator.GroupID, http.MethodGet, "")
	disabledResponse := httptest.NewRecorder()
	server.handleListExternalAccounts(disabledResponse, disabled)
	if disabledResponse.Code != http.StatusConflict || !strings.Contains(disabledResponse.Body.String(), `"code":"EXTERNAL_ACCOUNTS_DISABLED"`) {
		t.Fatalf("disabled response status=%d body=%s", disabledResponse.Code, disabledResponse.Body.String())
	}
	disabledMutation := roleHandlerRequest(principal, administrator.GroupID, http.MethodPost, `{`)
	disabledMutationResponse := httptest.NewRecorder()
	server.handleCreateExternalAccount(disabledMutationResponse, disabledMutation)
	if disabledMutationResponse.Code != http.StatusConflict || !strings.Contains(disabledMutationResponse.Body.String(), `"code":"EXTERNAL_ACCOUNTS_DISABLED"`) {
		t.Fatalf("disabled malformed mutation status=%d body=%s", disabledMutationResponse.Code, disabledMutationResponse.Body.String())
	}
	if _, err := server.db.Exec(`UPDATE group_settings SET external_accounts_enabled=1 WHERE group_id=?`, administrator.GroupID); err != nil {
		t.Fatal(err)
	}

	create := roleHandlerRequest(principal, administrator.GroupID, http.MethodPost, `{"name":"Operating PayPal","type":"PAYPAL","paypalMeHandle":"SensitiveHandle"}`)
	create.Header.Set("Idempotency-Key", "http-external-account-create")
	create.Header.Set("If-Match", `"v1"`)
	createdResponse := httptest.NewRecorder()
	server.handleCreateExternalAccount(createdResponse, create)
	if createdResponse.Code != http.StatusCreated || createdResponse.Header().Get("ETag") != "" || createdResponse.Header().Get(externalAccountsConfigETagHeader) != `"v2"` || createdResponse.Header().Get("Cache-Control") != "private, no-store" || strings.Contains(createdResponse.Body.String(), "SensitiveHandle") {
		t.Fatalf("create response status=%d etag=%q config-etag=%q cache=%q body=%s", createdResponse.Code, createdResponse.Header().Get("ETag"), createdResponse.Header().Get(externalAccountsConfigETagHeader), createdResponse.Header().Get("Cache-Control"), createdResponse.Body.String())
	}
	var created externalaccounts.AccountCollection
	if err := json.Unmarshal(createdResponse.Body.Bytes(), &created); err != nil || len(created.Items) != 1 || created.Items[0].PayPalMeHandle != "••••" {
		t.Fatalf("created collection=%#v err=%v", created, err)
	}
	beforeBalance := roleHandlerRequest(principal, administrator.GroupID, http.MethodGet, "")
	beforeBalanceResponse := httptest.NewRecorder()
	server.handleListExternalAccounts(beforeBalanceResponse, beforeBalance)
	if beforeBalanceResponse.Code != http.StatusOK || beforeBalanceResponse.Header().Get("ETag") != "" || beforeBalanceResponse.Header().Get(externalAccountsConfigETagHeader) != `"v2"` || beforeBalanceResponse.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("initial read status=%d etag=%q config-etag=%q cache=%q body=%s", beforeBalanceResponse.Code, beforeBalanceResponse.Header().Get("ETag"), beforeBalanceResponse.Header().Get(externalAccountsConfigETagHeader), beforeBalanceResponse.Header().Get("Cache-Control"), beforeBalanceResponse.Body.String())
	}
	deposit := roleHandlerRequest(principal, administrator.GroupID, http.MethodPost, `{"kind":"INCOME","destinationAccountId":"`+created.Items[0].ID+`","amountMinor":125,"occurredAt":"2026-09-13T11:00:00Z","reason":"Cash inflow"}`)
	deposit.Header.Set("Idempotency-Key", "http-external-account-deposit")
	depositResponse := httptest.NewRecorder()
	server.handleCreateExternalAccountTransaction(depositResponse, deposit)
	if depositResponse.Code != http.StatusCreated {
		t.Fatalf("deposit status=%d body=%s", depositResponse.Code, depositResponse.Body.String())
	}
	afterBalance := roleHandlerRequest(principal, administrator.GroupID, http.MethodGet, "")
	afterBalanceResponse := httptest.NewRecorder()
	server.handleListExternalAccounts(afterBalanceResponse, afterBalance)
	if afterBalanceResponse.Code != http.StatusOK || afterBalanceResponse.Header().Get("ETag") != "" || afterBalanceResponse.Header().Get(externalAccountsConfigETagHeader) != `"v2"` || beforeBalanceResponse.Body.String() == afterBalanceResponse.Body.String() || !strings.Contains(afterBalanceResponse.Body.String(), `"balanceMinor":"125"`) {
		t.Fatalf("balance read status=%d etag=%q config-etag=%q before=%s after=%s", afterBalanceResponse.Code, afterBalanceResponse.Header().Get("ETag"), afterBalanceResponse.Header().Get(externalAccountsConfigETagHeader), beforeBalanceResponse.Body.String(), afterBalanceResponse.Body.String())
	}

	replay := roleHandlerRequest(principal, administrator.GroupID, http.MethodPost, `{"name":"Operating PayPal","type":"PAYPAL","paypalMeHandle":"SensitiveHandle"}`)
	replay.Header.Set("Idempotency-Key", "http-external-account-create")
	replay.Header.Set("If-Match", `"v1"`)
	replayResponse := httptest.NewRecorder()
	server.handleCreateExternalAccount(replayResponse, replay)
	if replayResponse.Code != http.StatusCreated || replayResponse.Header().Get("ETag") != "" || replayResponse.Header().Get(externalAccountsConfigETagHeader) != `"v2"` || replayResponse.Body.String() != createdResponse.Body.String() {
		t.Fatalf("idempotent replay status=%d body=%s", replayResponse.Code, replayResponse.Body.String())
	}

	missing := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, `{"name":"Renamed","type":"PAYPAL","paypalMeHandle":"••••"}`)
	missing.SetPathValue("externalAccountID", created.Items[0].ID)
	missingResponse := httptest.NewRecorder()
	server.handleUpdateExternalAccount(missingResponse, missing)
	if missingResponse.Code != http.StatusPreconditionFailed {
		t.Fatalf("missing If-Match status=%d body=%s", missingResponse.Code, missingResponse.Body.String())
	}

	update := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, `{"name":"Renamed","type":"PAYPAL","paypalMeHandle":"••••"}`)
	update.SetPathValue("externalAccountID", created.Items[0].ID)
	update.Header.Set("If-Match", createdResponse.Header().Get(externalAccountsConfigETagHeader))
	updatedResponse := httptest.NewRecorder()
	server.handleUpdateExternalAccount(updatedResponse, update)
	if updatedResponse.Code != http.StatusOK || updatedResponse.Header().Get("ETag") != "" || updatedResponse.Header().Get(externalAccountsConfigETagHeader) != `"v3"` || strings.Contains(updatedResponse.Body.String(), "SensitiveHandle") {
		t.Fatalf("update status=%d etag=%q config-etag=%q body=%s", updatedResponse.Code, updatedResponse.Header().Get("ETag"), updatedResponse.Header().Get(externalAccountsConfigETagHeader), updatedResponse.Body.String())
	}

	missingDelete := roleHandlerRequest(principal, administrator.GroupID, http.MethodDelete, "")
	missingDelete.SetPathValue("externalAccountID", created.Items[0].ID)
	missingDeleteResponse := httptest.NewRecorder()
	server.handleDeleteExternalAccount(missingDeleteResponse, missingDelete)
	if missingDeleteResponse.Code != http.StatusPreconditionFailed {
		t.Fatalf("delete without If-Match status=%d body=%s", missingDeleteResponse.Code, missingDeleteResponse.Body.String())
	}

	staleDelete := roleHandlerRequest(principal, administrator.GroupID, http.MethodDelete, "")
	staleDelete.SetPathValue("externalAccountID", created.Items[0].ID)
	staleDelete.Header.Set("If-Match", `"v2"`)
	staleDeleteResponse := httptest.NewRecorder()
	server.handleDeleteExternalAccount(staleDeleteResponse, staleDelete)
	if staleDeleteResponse.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale delete status=%d body=%s", staleDeleteResponse.Code, staleDeleteResponse.Body.String())
	}

	activeDelete := roleHandlerRequest(principal, administrator.GroupID, http.MethodDelete, "")
	activeDelete.SetPathValue("externalAccountID", created.Items[0].ID)
	activeDelete.Header.Set("If-Match", `"v3"`)
	activeDeleteResponse := httptest.NewRecorder()
	server.handleDeleteExternalAccount(activeDeleteResponse, activeDelete)
	if activeDeleteResponse.Code != http.StatusConflict {
		t.Fatalf("active delete status=%d body=%s", activeDeleteResponse.Code, activeDeleteResponse.Body.String())
	}
}

func TestExternalAccountTransactionQueryRejectsInvalidMinorUnits(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/?amountMin=12.50", nil)
	if _, err := externalAccountTransactionQuery(request); err == nil {
		t.Fatal("expected amountMin validation error")
	}
}

func TestExternalAccountTransactionQueryPreservesRepeatedAccountFilters(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/?accountId=external-cash&accountId=external-bank", nil)
	query, err := externalAccountTransactionQuery(request)
	if err != nil {
		t.Fatalf("parse repeated account filters: %v", err)
	}
	if len(query.AccountIDs) != 2 || query.AccountIDs[0] != "external-cash" || query.AccountIDs[1] != "external-bank" {
		t.Fatalf("account filters=%v", query.AccountIDs)
	}
}
