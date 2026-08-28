package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
)

func TestGroupSettingsExposeOnlyNotificationDelivery(t *testing.T) {
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
	if settings.NotificationEmailsEnabled || settings.SettlementsEnabled {
		t.Fatalf("default settings = %#v", settings)
	}

	update := roleHandlerRequest(principal, administrator.GroupID, http.MethodPatch, `{"settlementsEnabled":true,"defaultTheme":"NRW"}`)
	updatedResponse := httptest.NewRecorder()
	server.handleUpdateGroupSettings(updatedResponse, update)
	if updatedResponse.Code != http.StatusOK {
		t.Fatalf("settings update status = %d, body = %s", updatedResponse.Code, updatedResponse.Body.String())
	}
	var updatedSettings domain.GroupSettings
	if err := json.Unmarshal(updatedResponse.Body.Bytes(), &updatedSettings); err != nil || !updatedSettings.SettlementsEnabled || updatedSettings.DefaultTheme != domain.ThemeNRW {
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
