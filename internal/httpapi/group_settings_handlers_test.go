package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/externalaccounts"
)

func TestGroupSettingsExposeFinanceReminderCadence(t *testing.T) {
	t.Parallel()
	server, principal, administrator := invitationImportServer(t, false)

	get := roleHandlerRequest(principal, administrator.GroupID, http.MethodGet, "")
	response := httptest.NewRecorder()
	server.handleGetGroupSettings(response, get)
	if response.Code != http.StatusOK {
		t.Fatalf("get settings status = %d, body = %s", response.Code, response.Body.String())
	}
	var settings domain.GroupSettings
	if err := json.Unmarshal(response.Body.Bytes(), &settings); err != nil {
		t.Fatalf("decode settings: %v", err)
	}
	if settings.SettlementsEnabled || settings.ExternalAccountsEnabled || settings.ExternalAccountsVersion != 1 || settings.SettlementDueSoonDays != 3 || settings.SettlementOverdueRepeatDays != 7 {
		t.Fatalf("default settings = %#v", settings)
	}

	update := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, `{"settlementsEnabled":true,"settlementDueSoonDays":5,"settlementOverdueRepeatDays":10,"defaultTheme":"NRW"}`)
	updatedResponse := httptest.NewRecorder()
	server.handleUpdateGroupSettings(updatedResponse, update)
	if updatedResponse.Code != http.StatusOK {
		t.Fatalf("settings update status = %d, body = %s", updatedResponse.Code, updatedResponse.Body.String())
	}
	var updatedSettings domain.GroupSettings
	if err := json.Unmarshal(updatedResponse.Body.Bytes(), &updatedSettings); err != nil || !updatedSettings.SettlementsEnabled || updatedSettings.SettlementDueSoonDays != 5 || updatedSettings.SettlementOverdueRepeatDays != 10 || updatedSettings.DefaultTheme != domain.ThemeNRW {
		t.Fatalf("updated settings = %#v, err = %v", updatedSettings, err)
	}

	unsupported := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, `{"membersCanViewAllBookings":true}`)
	unsupportedResponse := httptest.NewRecorder()
	server.handleUpdateGroupSettings(unsupportedResponse, unsupported)
	if unsupportedResponse.Code != http.StatusUnprocessableEntity {
		t.Fatalf("deprecated setting status = %d, body = %s", unsupportedResponse.Code, unsupportedResponse.Body.String())
	}
}

func TestMemberReactivationRejectsUnknownFields(t *testing.T) {
	t.Parallel()
	server, principal, administrator := invitationImportServer(t, false)
	request := roleHandlerRequest(principal, administrator.GroupID, http.MethodPost, `{"roleIds":[],"unexpected":true}`)
	request.SetPathValue("membershipID", "membership-archived")
	response := httptest.NewRecorder()

	server.handleReactivateMember(response, request)

	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("reactivation with unknown field status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestPaymentTargetPatchDistinguishesMissingNullAndObject(t *testing.T) {
	t.Parallel()
	server, principal, administrator := invitationImportServer(t, false)

	configure := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, `{
		"paymentMethods":[{
			"id":"PAYPAL","label":"PayPal","attachmentMode":"OFF",
			"paymentTarget":{"type":"PAYPAL_ME","paypalMeHandle":"https://paypal.me/Club123"}
		}]
	}`)
	configuredResponse := httptest.NewRecorder()
	server.handleUpdateGroupSettings(configuredResponse, configure)
	if configuredResponse.Code != http.StatusOK {
		t.Fatalf("configure target status = %d, body = %s", configuredResponse.Code, configuredResponse.Body.String())
	}
	var configured domain.GroupSettings
	if err := json.Unmarshal(configuredResponse.Body.Bytes(), &configured); err != nil || len(configured.PaymentMethods) != 1 ||
		configured.PaymentMethods[0].PaymentTarget == nil || configured.PaymentMethods[0].PaymentTarget.PayPalMeHandle != "Club123" {
		t.Fatalf("configured settings = %#v, err = %v", configured, err)
	}

	legacy := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch,
		`{"paymentMethods":[{"id":"PAYPAL","label":"Private PayPal","attachmentMode":"OFF"}]}`)
	legacyResponse := httptest.NewRecorder()
	server.handleUpdateGroupSettings(legacyResponse, legacy)
	if legacyResponse.Code != http.StatusOK {
		t.Fatalf("legacy patch status = %d, body = %s", legacyResponse.Code, legacyResponse.Body.String())
	}
	var preserved domain.GroupSettings
	if err := json.Unmarshal(legacyResponse.Body.Bytes(), &preserved); err != nil || preserved.PaymentMethods[0].PaymentTarget == nil ||
		preserved.PaymentMethods[0].PaymentTarget.PayPalMeHandle != "Club123" {
		t.Fatalf("preserved settings = %#v, err = %v", preserved, err)
	}

	transactionRequest := roleHandlerRequest(principal, administrator.GroupID, http.MethodGet, "")
	transactionResponse := httptest.NewRecorder()
	server.handleGetTransactionSettings(transactionResponse, transactionRequest)
	if transactionResponse.Code != http.StatusOK || !json.Valid(transactionResponse.Body.Bytes()) ||
		!bytes.Contains(transactionResponse.Body.Bytes(), []byte(`"paypalMeHandle":"Club123"`)) {
		t.Fatalf("transaction settings status/body = %d/%s", transactionResponse.Code, transactionResponse.Body.String())
	}

	clear := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch,
		`{"paymentMethods":[{"id":"PAYPAL","label":"Private PayPal","attachmentMode":"OFF","paymentTarget":null}]}`)
	clearResponse := httptest.NewRecorder()
	server.handleUpdateGroupSettings(clearResponse, clear)
	if clearResponse.Code != http.StatusOK || !bytes.Contains(clearResponse.Body.Bytes(), []byte(`"paymentTarget":null`)) {
		t.Fatalf("clear target status/body = %d/%s", clearResponse.Code, clearResponse.Body.String())
	}

	unknownNested := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, `{
		"paymentMethods":[{
			"id":"PAYPAL","label":"PayPal","attachmentMode":"OFF",
			"paymentTarget":{"type":"PAYPAL_ME","paypalMeHandle":"Club123","unexpected":true}
		}]
	}`)
	unknownResponse := httptest.NewRecorder()
	server.handleUpdateGroupSettings(unknownResponse, unknownNested)
	if unknownResponse.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unknown nested target field status = %d, body = %s", unknownResponse.Code, unknownResponse.Body.String())
	}
}

func TestRemovingPaymentMethodThroughSettingsAPIUnlinksAccount(t *testing.T) {
	t.Parallel()
	server, principal, administrator := invitationImportServer(t, false)
	server.externalAccounts = externalaccounts.Service{DB: server.db}
	if _, err := server.db.Exec(`INSERT OR IGNORE INTO role_permission_grants(group_id,role_id,permission_key,scope_type,version,created_at,updated_at)
		SELECT ?,role_id,?,'GROUP',1,'2026-09-13T10:00:00Z','2026-09-13T10:00:00Z' FROM membership_role_assignments WHERE group_id=? AND membership_id=?`,
		administrator.GroupID, "VIEW_EXTERNAL_ACCOUNTS", administrator.GroupID, administrator.ID); err != nil {
		t.Fatalf("grant account viewing: %v", err)
	}

	initialRequest := roleHandlerRequest(principal, administrator.GroupID, http.MethodGet, "")
	initialResponse := httptest.NewRecorder()
	server.handleGetGroupSettings(initialResponse, initialRequest)
	if initialResponse.Code != http.StatusOK {
		t.Fatalf("initial settings status = %d, body = %s", initialResponse.Code, initialResponse.Body.String())
	}
	var initial domain.GroupSettings
	if err := json.Unmarshal(initialResponse.Body.Bytes(), &initial); err != nil {
		t.Fatalf("decode initial settings: %v", err)
	}
	for index := range initial.PaymentMethods {
		if initial.PaymentMethods[index].ID == "BANK_TRANSFER" {
			initial.PaymentMethods[index].PaymentTarget = &domain.PaymentTarget{
				Type: domain.PaymentTargetSEPATransfer, RecipientName: "Team Club", IBAN: "DE89370400440532013000",
			}
		}
	}
	configuredMethods := make([]map[string]any, 0, len(initial.PaymentMethods))
	for _, method := range initial.PaymentMethods {
		configuredMethods = append(configuredMethods, map[string]any{
			"id": method.ID, "label": method.Label, "attachmentMode": method.AttachmentMode, "paymentTarget": method.PaymentTarget,
		})
	}
	configureBody, err := json.Marshal(map[string]any{"paymentMethods": configuredMethods})
	if err != nil {
		t.Fatalf("encode linked methods: %v", err)
	}
	configureRequest := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, string(configureBody))
	configureResponse := httptest.NewRecorder()
	server.handleUpdateGroupSettings(configureResponse, configureRequest)
	if configureResponse.Code != http.StatusOK {
		t.Fatalf("configure linked method status = %d, body = %s", configureResponse.Code, configureResponse.Body.String())
	}
	var linked domain.GroupSettings
	if err := json.Unmarshal(configureResponse.Body.Bytes(), &linked); err != nil {
		t.Fatalf("decode linked settings: %v", err)
	}
	remaining := make([]domain.PaymentMethod, 0, len(linked.PaymentMethods)-1)
	var accountID string
	for _, method := range linked.PaymentMethods {
		if method.ID == "BANK_TRANSFER" {
			if method.ExternalAccountID == nil {
				t.Fatal("linked method has no external account")
			}
			accountID = *method.ExternalAccountID
			continue
		}
		remaining = append(remaining, method)
	}
	if accountID == "" {
		t.Fatal("BANK_TRANSFER method missing from settings")
	}

	enableRequest := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, `{"externalAccountsEnabled":true}`)
	enableResponse := httptest.NewRecorder()
	server.handleUpdateGroupSettings(enableResponse, enableRequest)
	if enableResponse.Code != http.StatusOK {
		t.Fatalf("enable accounts status = %d, body = %s", enableResponse.Code, enableResponse.Body.String())
	}
	deleteBody, err := json.Marshal(map[string]any{"paymentMethods": remaining})
	if err != nil {
		t.Fatalf("encode remaining methods: %v", err)
	}
	deleteRequest := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, string(deleteBody))
	deleteResponse := httptest.NewRecorder()
	server.handleUpdateGroupSettings(deleteResponse, deleteRequest)
	if deleteResponse.Code != http.StatusOK {
		t.Fatalf("delete method status = %d, body = %s", deleteResponse.Code, deleteResponse.Body.String())
	}

	reloadRequest := roleHandlerRequest(principal, administrator.GroupID, http.MethodGet, "")
	reloadResponse := httptest.NewRecorder()
	server.handleGetGroupSettings(reloadResponse, reloadRequest)
	var reloaded domain.GroupSettings
	if reloadResponse.Code != http.StatusOK || json.Unmarshal(reloadResponse.Body.Bytes(), &reloaded) != nil {
		t.Fatalf("reload settings status = %d, body = %s", reloadResponse.Code, reloadResponse.Body.String())
	}
	for _, method := range reloaded.PaymentMethods {
		if method.ID == "BANK_TRANSFER" {
			t.Fatal("deleted payment method returned after reload")
		}
	}
	accountsRequest := roleHandlerRequest(principal, administrator.GroupID, http.MethodGet, "")
	accountsResponse := httptest.NewRecorder()
	server.handleListExternalAccounts(accountsResponse, accountsRequest)
	var accounts externalaccounts.AccountCollection
	if accountsResponse.Code != http.StatusOK || json.Unmarshal(accountsResponse.Body.Bytes(), &accounts) != nil {
		t.Fatalf("reload external accounts status = %d, body = %s", accountsResponse.Code, accountsResponse.Body.String())
	}
	for _, account := range accounts.Items {
		if account.ID == accountID {
			if len(account.LinkedPaymentMethodIDs) != 0 {
				t.Fatalf("deleted method remains linked to account: %v", account.LinkedPaymentMethodIDs)
			}
			return
		}
	}
	t.Fatal("external account disappeared after unlinking")
}
