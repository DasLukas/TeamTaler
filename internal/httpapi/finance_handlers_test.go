package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/authorization"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/finance"
	systemadmin "github.com/DasLukas/TeamTaler/internal/system"
)

func TestAccountGroupStatisticsRequireEnabledFeatureAndUnifiedPermission(t *testing.T) {
	t.Parallel()

	server, _, membership := invitationImportServer(t, false)
	server.finance = finance.Service{DB: server.db}
	if _, err := server.db.Exec(`INSERT INTO categories(id,group_id,name,active,sort_order,version,created_at,updated_at,icon)
		VALUES('category-account-statistics',?,'Account statistics',1,0,1,'2026-08-06T00:00:00Z','2026-08-06T00:00:00Z','other')`, membership.GroupID); err != nil {
		t.Fatalf("insert account statistics category: %v", err)
	}
	roleID := authorization.PresetRoleID(membership.GroupID, domain.RolePresetGroupAdministrator)
	if _, err := server.db.Exec(`INSERT INTO role_permission_grants(group_id,role_id,permission_key,scope_type,version,created_at,updated_at)
		VALUES(?,?,?,'GROUP',1,'2026-08-06T00:00:00Z','2026-08-06T00:00:00Z')`, membership.GroupID, roleID, domain.PermissionViewStatistics); err != nil {
		t.Fatalf("grant statistics permission: %v", err)
	}

	readAccount := func() finance.Account {
		t.Helper()
		account, err := server.finance.Account(context.Background(), membership, membership.ID)
		if err != nil {
			t.Fatalf("read account: %v", err)
		}
		return account
	}

	account := readAccount()
	if len(account.CategoryStats) != 1 || len(account.GroupCategoryStats) != 0 {
		t.Fatalf("disabled statistics account=%#v", account)
	}
	if _, err := server.db.Exec(`UPDATE group_settings SET statistics_enabled=1 WHERE group_id=?`, membership.GroupID); err != nil {
		t.Fatalf("enable statistics: %v", err)
	}
	account = readAccount()
	if len(account.CategoryStats) != 1 || len(account.GroupCategoryStats) != 1 {
		t.Fatalf("enabled statistics account=%#v", account)
	}
	if _, err := server.db.Exec(`DELETE FROM role_permission_grants WHERE group_id=? AND role_id=? AND permission_key=?`, membership.GroupID, roleID, domain.PermissionViewStatistics); err != nil {
		t.Fatalf("remove statistics permission: %v", err)
	}
	account = readAccount()
	if len(account.CategoryStats) != 1 || len(account.GroupCategoryStats) != 0 {
		t.Fatalf("ungranted statistics account=%#v", account)
	}
}

func TestHandleCreateOwnPaymentDerivesAuthenticatedMembershipAndRejectsTargetFields(t *testing.T) {
	t.Parallel()

	server, principal, membership := invitationImportServer(t, false)
	server.finance = finance.Service{DB: server.db}
	membership = assignTestTemplateRoles(t, context.Background(), server.groups, principal, membership, domain.RoleTemplateFinance)
	request := ownPaymentRequest(principal, membership.GroupID, `{"amountMinor":125,"receivedAt":"2026-08-06T00:00:00Z","method":"PAYPAL","reference":"Own PayPal payment"}`)
	response := httptest.NewRecorder()

	server.handleCreateOwnPayment(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var payment domain.Payment
	if err := json.Unmarshal(response.Body.Bytes(), &payment); err != nil {
		t.Fatalf("decode own payment response: %v", err)
	}
	if payment.MembershipID != membership.ID || payment.Method != "PAYPAL" || payment.Status != "POSTED" {
		t.Fatalf("own payment = %#v", payment)
	}

	unknownTargetRequest := ownPaymentRequest(principal, membership.GroupID, `{"membershipId":"mem_foreign","amountMinor":125,"receivedAt":"2026-08-06T00:00:00Z","method":"CASH"}`)
	unknownTargetResponse := httptest.NewRecorder()
	server.handleCreateOwnPayment(unknownTargetResponse, unknownTargetRequest)
	if unknownTargetResponse.Code != http.StatusUnprocessableEntity || !strings.Contains(unknownTargetResponse.Body.String(), "unknown field") {
		t.Fatalf("foreign target status = %d, body = %s", unknownTargetResponse.Code, unknownTargetResponse.Body.String())
	}

	missingDateRequest := ownPaymentRequest(principal, membership.GroupID, `{"amountMinor":125,"method":"CASH"}`)
	missingDateResponse := httptest.NewRecorder()
	server.handleCreateOwnPayment(missingDateResponse, missingDateRequest)
	if missingDateResponse.Code != http.StatusUnprocessableEntity || !strings.Contains(missingDateResponse.Body.String(), "receivedAt") {
		t.Fatalf("missing date status = %d, body = %s", missingDateResponse.Code, missingDateResponse.Body.String())
	}

	missingReferenceRequest := ownPaymentRequest(principal, membership.GroupID, `{"amountMinor":125,"receivedAt":"2026-08-06T00:00:00Z","method":"PAYPAL"}`)
	missingReferenceResponse := httptest.NewRecorder()
	server.handleCreateOwnPayment(missingReferenceResponse, missingReferenceRequest)
	if missingReferenceResponse.Code != http.StatusUnprocessableEntity || !strings.Contains(missingReferenceResponse.Body.String(), "reference") {
		t.Fatalf("missing reference status = %d, body = %s", missingReferenceResponse.Code, missingReferenceResponse.Body.String())
	}
}

func TestDecodePaymentMultipartAcceptsBrowserJSONBlobAndRejectsUnknownParts(t *testing.T) {
	build := func(includeUnknown bool) *http.Request {
		t.Helper()
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		commandHeader := textproto.MIMEHeader{}
		commandHeader.Set("Content-Disposition", `form-data; name="command"; filename="command.json"`)
		commandHeader.Set("Content-Type", "application/json")
		command, err := writer.CreatePart(commandHeader)
		if err != nil {
			t.Fatalf("create command part: %v", err)
		}
		_, _ = command.Write([]byte(`{"amountMinor":125,"receivedAt":"2026-08-06T00:00:00Z","method":"CASH"}`))
		attachment, err := writer.CreateFormFile("attachment", "receipt.pdf")
		if err != nil {
			t.Fatalf("create attachment part: %v", err)
		}
		_, _ = attachment.Write([]byte("%PDF-1.7\n%%EOF"))
		if includeUnknown {
			unknown, _ := writer.CreateFormField("unexpected")
			_, _ = unknown.Write([]byte("value"))
		}
		if err := writer.Close(); err != nil {
			t.Fatalf("close multipart writer: %v", err)
		}
		request := httptest.NewRequest(http.MethodPost, "/api/v1/groups/grp_test/payments/self", bytes.NewReader(body.Bytes()))
		request.Header.Set("Content-Type", writer.FormDataContentType())
		settings := systemadmin.Settings{AttachmentUploadMaxBytes: systemadmin.Setting[int64]{Value: 1 << 20}}
		return request.WithContext(context.WithValue(request.Context(), systemSettingsKey, settings))
	}
	server := &Server{}
	var input finance.CreateOwnPaymentInput
	upload, err := server.decodePaymentCommand(httptest.NewRecorder(), build(false), &input)
	if err != nil || upload == nil || upload.FileName != "receipt.pdf" || input.Method != "CASH" {
		t.Fatalf("decoded input=%#v upload=%#v err=%v", input, upload, err)
	}
	if _, err := server.decodePaymentCommand(httptest.NewRecorder(), build(true), &input); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("unknown multipart part error=%v, want validation", err)
	}
}

func TestPaymentAttachmentHidesForeignGroupMembership(t *testing.T) {
	t.Parallel()
	server, principal, _ := invitationImportServer(t, false)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/groups/grp_foreign/payments/pay_missing/attachment", nil)
	request.SetPathValue("groupID", "grp_foreign")
	request.SetPathValue("paymentID", "pay_missing")
	request = request.WithContext(context.WithValue(request.Context(), principalKey, principal))
	response := httptest.NewRecorder()

	server.handlePaymentAttachment(response, request)

	if response.Code != http.StatusNotFound {
		t.Fatalf("foreign group status=%d body=%s, want 404", response.Code, response.Body.String())
	}
}

func ownPaymentRequest(principal domain.Principal, groupID, body string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/groups/"+groupID+"/payments/self", bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", fmt.Sprintf("self-payment-http-test-%x", sha256.Sum256([]byte(body)))[:48])
	request.SetPathValue("groupID", groupID)
	return request.WithContext(context.WithValue(request.Context(), principalKey, principal))
}
