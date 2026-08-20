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

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/finance"
	systemadmin "github.com/DasLukas/TeamTaler/internal/system"
)

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
