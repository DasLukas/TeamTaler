package groups

import (
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
)

func TestNormalizePayPalMeHandleAcceptsOnlyCanonicalRecipientInputs(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "bare", input: " Club123 ", want: "Club123"},
		{name: "canonical URL", input: "https://paypal.me/Club123", want: "Club123"},
		{name: "www URL", input: "https://www.paypal.me/Club123/", want: "Club123"},
		{name: "host without scheme", input: "paypal.me/Club123", want: "Club123"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := normalizePayPalMeHandle(test.input)
			if err != nil || got != test.want {
				t.Fatalf("normalize %q = %q, %v; want %q", test.input, got, err, test.want)
			}
		})
	}
	for _, input := range []string{
		"", "bad-handle", "abcdefghijklmnopqrstu", "http://paypal.me/Club123", "https://evil.example/Club123",
		"https://paypal.me.evil.example/Club123", "https://user@paypal.me/Club123", "https://paypal.me:443/Club123",
		"https://paypal.me/Club123/25EUR", "https://paypal.me/Club123?amount=25", "https://paypal.me/%43lub123",
	} {
		t.Run("reject "+input, func(t *testing.T) {
			if _, err := normalizePayPalMeHandle(input); err == nil {
				t.Fatalf("invalid PayPal.Me input %q unexpectedly passed", input)
			}
		})
	}
}

func TestNormalizePaymentTargetValidatesSEPAAndVariantFields(t *testing.T) {
	sepa, err := normalizePaymentTarget(&domain.PaymentTarget{
		Type: domain.PaymentTargetSEPATransfer, RecipientName: " Team Club ", IBAN: "de89 3704 0044 0532 0130 00", BIC: " cobadeffxxx ",
	}, "EUR")
	if err != nil {
		t.Fatalf("normalize SEPA target: %v", err)
	}
	if sepa.RecipientName != "Team Club" || sepa.IBAN != "DE89370400440532013000" || sepa.BIC != "COBADEFFXXX" {
		t.Fatalf("normalized SEPA target = %#v", sepa)
	}
	if _, err := normalizePaymentTarget(&domain.PaymentTarget{
		Type: domain.PaymentTargetSEPATransfer, RecipientName: "Team Club", IBAN: "DE89370400440532013000",
	}, "EUR"); err != nil {
		t.Fatalf("EEA IBAN without BIC: %v", err)
	}
	nonEEA, err := normalizePaymentTarget(&domain.PaymentTarget{
		Type: domain.PaymentTargetSEPATransfer, RecipientName: "British Club", IBAN: "GB82WEST12345698765432", BIC: "NWBKGB2L",
	}, "EUR")
	if err != nil || nonEEA.BIC != "NWBKGB2L" {
		t.Fatalf("non-EEA IBAN with BIC = %#v, %v", nonEEA, err)
	}
	payPal, err := normalizePaymentTarget(&domain.PaymentTarget{Type: domain.PaymentTargetPayPalMe, PayPalMeHandle: "https://paypal.me/Club123"}, "USD")
	if err != nil || payPal.PayPalMeHandle != "Club123" {
		t.Fatalf("normalize PayPal.Me target = %#v, %v", payPal, err)
	}
	invalidTargets := []struct {
		name     string
		currency string
		target   domain.PaymentTarget
	}{
		{name: "SEPA non-EUR", currency: "USD", target: domain.PaymentTarget{Type: domain.PaymentTargetSEPATransfer, RecipientName: "Team", IBAN: "DE89370400440532013000"}},
		{name: "invalid checksum", currency: "EUR", target: domain.PaymentTarget{Type: domain.PaymentTargetSEPATransfer, RecipientName: "Team", IBAN: "DE89370400440532013001"}},
		{name: "invalid BIC", currency: "EUR", target: domain.PaymentTarget{Type: domain.PaymentTargetSEPATransfer, RecipientName: "Team", IBAN: "DE89370400440532013000", BIC: "12345678"}},
		{name: "GB without required BIC", currency: "EUR", target: domain.PaymentTarget{Type: domain.PaymentTargetSEPATransfer, RecipientName: "British Club", IBAN: "GB82WEST12345698765432"}},
		{name: "CH without required BIC", currency: "EUR", target: domain.PaymentTarget{Type: domain.PaymentTargetSEPATransfer, RecipientName: "Swiss Club", IBAN: "CH9300762011623852957"}},
		{name: "empty recipient", currency: "EUR", target: domain.PaymentTarget{Type: domain.PaymentTargetSEPATransfer, RecipientName: " ", IBAN: "DE89370400440532013000"}},
		{name: "control recipient", currency: "EUR", target: domain.PaymentTarget{Type: domain.PaymentTargetSEPATransfer, RecipientName: "Team\nClub", IBAN: "DE89370400440532013000"}},
		{name: "SEPA with PayPal field", currency: "EUR", target: domain.PaymentTarget{Type: domain.PaymentTargetSEPATransfer, PayPalMeHandle: "Club", RecipientName: "Team", IBAN: "DE89370400440532013000"}},
		{name: "PayPal with SEPA field", currency: "EUR", target: domain.PaymentTarget{Type: domain.PaymentTargetPayPalMe, PayPalMeHandle: "Club", IBAN: "DE89370400440532013000"}},
		{name: "unknown type", currency: "EUR", target: domain.PaymentTarget{Type: "CARD"}},
	}
	for _, test := range invalidTargets {
		t.Run(test.name, func(t *testing.T) {
			if _, err := normalizePaymentTarget(&test.target, test.currency); err == nil {
				t.Fatalf("invalid target %#v unexpectedly passed", test.target)
			}
		})
	}
}

func TestValidIBANUsesGenericMOD97Validation(t *testing.T) {
	for _, value := range []string{"DE89370400440532013000", "GB82WEST12345698765432", "CH9300762011623852957"} {
		if !validIBAN(value) {
			t.Fatalf("valid IBAN %q was rejected", value)
		}
	}
	for _, value := range []string{"DE89370400440532013001", "DE00", "XX12INVALID!"} {
		if validIBAN(value) {
			t.Fatalf("invalid IBAN %q unexpectedly passed", value)
		}
	}
	if ibanRequiresBIC("DE89370400440532013000") || !ibanRequiresBIC("GB82WEST12345698765432") || !ibanRequiresBIC("CH9300762011623852957") {
		t.Fatal("EEA BIC-omission rule was evaluated incorrectly")
	}
}
