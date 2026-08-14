package integration_test

import (
	"errors"
	"testing"

	"github.com/DasLukas/TeamTaler/internal/bookings"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/finance"
	"github.com/DasLukas/TeamTaler/internal/groups"
)

func TestTransactionSettingsControlBookingsPaymentsAndHistoricalLabels(t *testing.T) {
	f := newFixture(t)
	_, target, _ := f.inviteMember("transaction-target@example.test", "Transaction Target", nil)
	_, product := f.catalogItem("Transaction Settings", 250)
	ownBookingReasonMode := domain.ReasonModeRequired
	foreignBookingReasonMode := domain.ReasonModeOptional
	ownPaymentReasonMode := domain.ReasonModeOff
	otherPaymentReasonMode := domain.ReasonModeRequired
	paymentMethods := []domain.ConfigurableItem{{ID: "CARD", Label: "Card terminal"}}
	bookingReasons := []domain.ConfigurableItem{{ID: "TEAM", Label: "Team event"}}
	paymentReasons := []domain.ConfigurableItem{{ID: "MONTHLY", Label: "Monthly settlement"}}
	if _, err := f.groups.UpdateSettings(f.ctx, f.admin, f.membership, groups.SettingsUpdate{
		OwnBookingReasonMode:     &ownBookingReasonMode,
		ForeignBookingReasonMode: &foreignBookingReasonMode,
		OwnPaymentReasonMode:     &ownPaymentReasonMode,
		OtherPaymentReasonMode:   &otherPaymentReasonMode,
		PaymentMethods:           &paymentMethods,
		BookingReasons:           &bookingReasons,
		PaymentReasons:           &paymentReasons,
	}); err != nil {
		t.Fatalf("update transaction settings: %v", err)
	}

	if _, err := f.bookings.Create(f.ctx, f.admin, f.membership, "optional-foreign-booking-reason", bookings.CreateInput{
		ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: f.openPeriodID(), Quantity: 1, TargetMembershipID: target.ID,
	}); err != nil {
		t.Fatalf("create foreign booking without optional reason: %v", err)
	}
	if _, err := f.bookings.Create(f.ctx, f.admin, f.membership, "required-own-booking-reason", bookings.CreateInput{
		ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: f.openPeriodID(), Quantity: 1, TargetMembershipID: f.membership.ID,
	}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("own booking without required reason error=%v, want validation", err)
	}
	ownBooking, err := f.bookings.Create(f.ctx, f.admin, f.membership, "own-booking-with-reason", bookings.CreateInput{
		ProductID: product.ID, ProductVersion: product.Version, ExpectedPeriodID: f.openPeriodID(), Quantity: 1, TargetMembershipID: f.membership.ID, Reason: "Team event",
	})
	if err != nil || ownBooking.Reason != "Team event" {
		t.Fatalf("own booking=%#v err=%v", ownBooking, err)
	}
	selfPayment, err := f.finance.CreateOwnPayment(f.ctx, f.admin, f.membership, "optional-own-payment-reason", finance.CreateOwnPaymentInput{
		AmountMinor: 100, ReceivedAt: "2026-08-11T00:00:00Z", Method: "CARD", Reference: "Must be discarded",
	})
	if err != nil {
		t.Fatalf("create own payment without optional reason: %v", err)
	}
	if selfPayment.MethodLabel != "Card terminal" {
		t.Fatalf("self payment method label=%q", selfPayment.MethodLabel)
	}
	if selfPayment.Reference != "" {
		t.Fatalf("self payment reference=%q, want discarded in OFF mode", selfPayment.Reference)
	}
	if _, err := f.finance.CreatePayment(f.ctx, f.admin, f.membership, "required-managed-payment-reason", finance.CreatePaymentInput{
		MembershipID: target.ID, AmountMinor: 100, Method: "CARD",
	}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("managed payment without required reason error=%v, want validation", err)
	}
	if _, err := f.finance.CreatePayment(f.ctx, f.admin, f.membership, "managed-payment-with-reason", finance.CreatePaymentInput{
		MembershipID: target.ID, AmountMinor: 100, Method: "CARD", Reference: "Monthly settlement",
	}); err != nil {
		t.Fatalf("create managed payment with reason: %v", err)
	}

	renamedMethods := []domain.ConfigurableItem{{ID: "CARD", Label: "Debit card"}}
	if _, err := f.groups.UpdateSettings(f.ctx, f.admin, f.membership, groups.SettingsUpdate{PaymentMethods: &renamedMethods}); err != nil {
		t.Fatalf("rename payment method: %v", err)
	}
	payments, err := f.finance.ListPayments(f.ctx, f.membership, 20)
	if err != nil {
		t.Fatalf("list payments: %v", err)
	}
	for _, payment := range payments {
		if payment.ID == selfPayment.ID && payment.MethodLabel != "Card terminal" {
			t.Fatalf("historical method label=%q, want Card terminal", payment.MethodLabel)
		}
	}
	legacyMethods := []domain.ConfigurableItem{{ID: "CASH", Label: "Cash"}}
	if _, err := f.groups.UpdateSettings(f.ctx, f.admin, f.membership, groups.SettingsUpdate{PaymentMethods: &legacyMethods}); err != nil {
		t.Fatalf("replace payment method: %v", err)
	}
	if _, err := f.finance.CreateOwnPayment(f.ctx, f.admin, f.membership, "removed-payment-method", finance.CreateOwnPaymentInput{
		AmountMinor: 100, ReceivedAt: "2026-08-11T00:00:00Z", Method: "CARD",
	}); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("removed payment method error=%v, want validation", err)
	}
}
