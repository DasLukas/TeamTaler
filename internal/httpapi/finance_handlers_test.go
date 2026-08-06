package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/finance"
)

func TestHandleCreateOwnPaymentDerivesAuthenticatedMembershipAndRejectsTargetFields(t *testing.T) {
	t.Parallel()

	server, principal, membership := invitationImportServer(t, false)
	server.finance = finance.Service{DB: server.db}
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

func ownPaymentRequest(principal domain.Principal, groupID, body string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/groups/"+groupID+"/payments/self", bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "self-payment-http-test")
	request.SetPathValue("groupID", groupID)
	return request.WithContext(context.WithValue(request.Context(), principalKey, principal))
}
