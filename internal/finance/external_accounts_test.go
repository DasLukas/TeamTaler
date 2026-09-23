package finance

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/externalaccounts"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/notifications"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestLinkedPaymentAndReversalPreserveOriginalExternalAccount(t *testing.T) {
	ctx := context.Background()
	database, err := storage.Open(ctx, filepath.Join(t.TempDir(), "linked-payment.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	authentication := auth.Service{DB: database, SessionLifetime: time.Hour}
	if err := authentication.Bootstrap(ctx, "finance@example.test", "Finance User", "correct-horse-battery-staple", "Finance Group", "EUR"); err != nil {
		t.Fatal(err)
	}
	session, err := authentication.Login(ctx, "finance@example.test", "correct-horse-battery-staple")
	if err != nil {
		t.Fatal(err)
	}
	groupItems, err := (groups.Service{DB: database}).List(ctx, session.Principal.UserID)
	if err != nil || len(groupItems) != 1 {
		t.Fatalf("groups=%#v err=%v", groupItems, err)
	}
	membership := groupItems[0].Membership
	if _, err := database.ExecContext(ctx, `INSERT INTO membership_role_assignments(group_id,membership_id,role_id,version,assigned_at) VALUES(?,?,?,1,'2026-09-01T00:00:00Z')`, membership.GroupID, membership.ID, "role:FINANCE_MANAGER:"+membership.GroupID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE group_settings SET external_accounts_enabled=1 WHERE group_id=?`, membership.GroupID); err != nil {
		t.Fatal(err)
	}

	externalService := externalaccounts.Service{DB: database}
	state, err := externalService.CreateAccount(ctx, session.Principal, membership, "payment-cash-account", 1, externalaccounts.CreateAccountInput{AccountInput: externalaccounts.AccountInput{Name: "Cash box", Type: "CASH"}})
	if err != nil || len(state.Items) != 1 {
		t.Fatalf("create account: %#v err=%v", state, err)
	}
	accountID := state.Items[0].ID
	if _, err := database.ExecContext(ctx, `UPDATE group_payment_methods SET external_account_id=? WHERE group_id=? AND id='CASH'`, accountID, membership.GroupID); err != nil {
		t.Fatal(err)
	}

	service := Service{DB: database, Notifications: notifications.Service{DB: database}}
	payment, err := service.CreatePayment(ctx, session.Principal, membership, "linked-payment-create", CreatePaymentInput{
		MembershipID: membership.ID, AmountMinor: 500, ReceivedAt: "2026-09-02T10:00:00Z", Method: "CASH", Reference: "Deposit",
	})
	if err != nil {
		t.Fatalf("create linked payment: %v", err)
	}
	var paymentTransactionID string
	var transactionAmount, accountLedger, receivableLedger int64
	if err := database.QueryRowContext(ctx, `SELECT id,amount_minor FROM external_account_transactions WHERE group_id=? AND payment_id=? AND kind='PAYMENT'`, membership.GroupID, payment.ID).Scan(&paymentTransactionID, &transactionAmount); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(ctx, `SELECT amount_minor FROM ledger_entries WHERE group_id=? AND payment_id=? AND account='EXTERNAL_ACCOUNT'`, membership.GroupID, payment.ID).Scan(&accountLedger); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(ctx, `SELECT amount_minor FROM ledger_entries WHERE group_id=? AND payment_id=? AND account='MEMBER_RECEIVABLE'`, membership.GroupID, payment.ID).Scan(&receivableLedger); err != nil {
		t.Fatal(err)
	}
	if transactionAmount != 500 || accountLedger != 500 || receivableLedger != -500 {
		t.Fatalf("payment amounts transaction=%d account=%d receivable=%d", transactionAmount, accountLedger, receivableLedger)
	}

	// Later remapping must not affect reversal of the immutable original leg.
	if _, err := database.ExecContext(ctx, `UPDATE group_payment_methods SET external_account_id=NULL WHERE group_id=? AND id='CASH'`, membership.GroupID); err != nil {
		t.Fatal(err)
	}
	if _, err := externalService.CreateTransaction(ctx, session.Principal, membership, "balance-payment-account-before-delete", externalaccounts.CreateTransactionInput{
		Kind: "EXPENSE", SourceAccountID: accountID, AmountMinor: 500, OccurredAt: "2026-09-02T11:00:00Z", Reason: "Move linked cash before account removal",
	}); err != nil {
		t.Fatalf("balance account before historical deletion: %v", err)
	}
	archived, err := externalService.SetAccountArchived(ctx, session.Principal, membership, accountID, true, state.Version)
	if err != nil {
		t.Fatalf("archive balanced account: %v", err)
	}
	removed, err := externalService.DeleteAccount(ctx, session.Principal, membership, accountID, archived.Version)
	if err != nil || len(removed.Items) != 0 {
		t.Fatalf("historically delete balanced account: state=%#v err=%v", removed, err)
	}
	if err := service.ReversePayment(ctx, session.Principal, membership, "linked-payment-reverse", payment.ID, "Duplicate"); err != nil {
		t.Fatalf("reverse linked payment: %v", err)
	}
	var reversalOf, reversalAccount string
	var reversalAmount int64
	if err := database.QueryRowContext(ctx, `SELECT reversal_of,primary_account_id,amount_minor FROM external_account_transactions WHERE group_id=? AND kind='REVERSAL'`, membership.GroupID).Scan(&reversalOf, &reversalAccount, &reversalAmount); err != nil {
		t.Fatal(err)
	}
	if reversalOf != paymentTransactionID || reversalAccount != accountID || reversalAmount != -500 {
		t.Fatalf("reversal original=%q account=%q amount=%d", reversalOf, reversalAccount, reversalAmount)
	}
	var balance int64
	if err := database.QueryRowContext(ctx, `SELECT coalesce(sum(amount_minor),0) FROM ledger_entries WHERE group_id=? AND external_account_id=?`, membership.GroupID, accountID).Scan(&balance); err != nil {
		t.Fatal(err)
	}
	if balance != -500 {
		t.Fatalf("external balance=%d, want -500 after restoring the historical identity", balance)
	}
	restored, err := externalService.ListAccounts(ctx, membership)
	if err != nil || len(restored.Items) != 1 || restored.Items[0].ID != accountID || restored.Items[0].Status != "ARCHIVED" || restored.Items[0].BalanceMinor != -500 {
		t.Fatalf("restored external account=%#v err=%v", restored, err)
	}
	var groupCashRows int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM ledger_entries WHERE group_id=? AND payment_id=? AND account='GROUP_CASH'`, membership.GroupID, payment.ID).Scan(&groupCashRows); err != nil {
		t.Fatal(err)
	}
	if groupCashRows != 0 {
		t.Fatalf("linked payment produced %d group-cash rows", groupCashRows)
	}

}
