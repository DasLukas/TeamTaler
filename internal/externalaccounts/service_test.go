package externalaccounts

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/DasLukas/TeamTaler/internal/auth"
	"github.com/DasLukas/TeamTaler/internal/domain"
	"github.com/DasLukas/TeamTaler/internal/groups"
	"github.com/DasLukas/TeamTaler/internal/paymentattachments"
	"github.com/DasLukas/TeamTaler/internal/storage"
)

func TestAccountMovementsReversalAndIndependentPostingAndAuditRedaction(t *testing.T) {
	ctx, service, principal, membership, database := externalAccountFixture(t)

	accounts, err := service.CreateAccount(ctx, principal, membership, "create-cash-account", 1, CreateAccountInput{
		AccountInput:   AccountInput{Name: "Secret Cash Name", Type: "CASH"},
		OpeningBalance: &OpeningBalanceInput{AmountMinor: 1000, OccurredAt: "2026-09-01", Reason: "Secret opening reason", Reference: "Secret opening reference", Note: "Secret opening note"},
	})
	if err != nil || len(accounts.Items) != 1 || accounts.Items[0].BalanceMinor != 1000 || !accounts.Items[0].HasTransactions {
		t.Fatalf("create cash account: accounts=%#v err=%v", accounts, err)
	}
	cash := accounts.Items[0]
	accounts, err = service.CreateAccount(ctx, principal, membership, "create-paypal-account", accounts.Version, CreateAccountInput{
		AccountInput: AccountInput{Name: "Secret PayPal Name", Type: "PAYPAL", PayPalMeHandle: "SecretHandle"},
	})
	if err != nil || len(accounts.Items) != 2 {
		t.Fatalf("create PayPal account: accounts=%#v err=%v", accounts, err)
	}
	var paypal domain.ExternalAccount
	for _, item := range accounts.Items {
		if item.Type == domain.ExternalAccountPayPal {
			paypal = item
		}
	}
	if paypal.PayPalMeHandle != "••••" || strings.Contains(paypal.PayPalMeHandle, "SecretHandle") {
		t.Fatalf("PayPal account exposed provider details: %#v", paypal)
	}
	accounts, err = service.UpdateAccount(ctx, principal, membership, paypal.ID, AccountInput{Name: "Renamed PayPal", Type: "PAYPAL", PayPalMeHandle: paypal.PayPalMeHandle}, accounts.Version)
	if err != nil {
		t.Fatalf("update with masked provider details: %v", err)
	}
	var storedHandle string
	if err := database.QueryRowContext(ctx, `SELECT paypal_me_handle FROM external_accounts WHERE id=?`, paypal.ID).Scan(&storedHandle); err != nil || storedHandle != "SecretHandle" {
		t.Fatalf("masked update changed stored handle: handle=%q err=%v", storedHandle, err)
	}
	if _, err := service.CreateTransaction(ctx, principal, membership, "foreign-income-account", CreateTransactionInput{Kind: "INCOME", DestinationAccountID: "exa_foreign", AmountMinor: 10, OccurredAt: "2026-09-02", Reason: "Foreign destination"}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("foreign destination error=%v, want not found", err)
	}
	if _, err := service.CreateTransaction(ctx, principal, membership, "foreign-transfer-account", CreateTransactionInput{Kind: "TRANSFER", SourceAccountID: cash.ID, DestinationAccountID: "exa_foreign", AmountMinor: 10, OccurredAt: "2026-09-02", Reason: "Foreign transfer"}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("foreign transfer error=%v, want not found", err)
	}
	if _, err := service.CreateTransaction(ctx, principal, membership, "legacy-adjustment", CreateTransactionInput{Kind: "ADJUSTMENT", SourceAccountID: cash.ID, AmountMinor: 10, OccurredAt: "2026-09-02", Reason: "Balance fix"}); err == nil {
		t.Fatal("new standalone adjustment was accepted")
	}
	links, err := service.ListPaymentMethodLinks(ctx, membership)
	if err != nil || len(links.Links) == 0 {
		t.Fatalf("list links: %#v err=%v", links, err)
	}
	links.Links[0].ExternalAccountID = stringAddress("exa_foreign")
	if _, err := service.ReplacePaymentMethodLinks(ctx, principal, membership, ReplaceLinksInput{Links: links.Links}, accounts.Version); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("foreign link error=%v, want not found", err)
	}

	income, err := service.CreateTransaction(ctx, principal, membership, "income-command-001", CreateTransactionInput{
		Kind: "INCOME", DestinationAccountID: cash.ID, AmountMinor: 200, OccurredAt: "2026-09-02", Reason: "Secret income reason", Reference: "Secret transaction reference", Note: "Secret transaction note",
	})
	if err != nil || income.AmountMinor != 200 {
		t.Fatalf("create income: transaction=%#v err=%v", income, err)
	}
	expense, err := service.CreateTransaction(ctx, principal, membership, "expense-command-01", CreateTransactionInput{
		Kind: "EXPENSE", SourceAccountID: cash.ID, AmountMinor: 150, OccurredAt: "2026-09-03", Reason: "External purchase",
	})
	if err != nil || expense.AmountMinor != -150 {
		t.Fatalf("create expense: %#v err=%v", expense, err)
	}
	transfer, err := service.CreateTransaction(ctx, principal, membership, "transfer-command-1", CreateTransactionInput{
		Kind: "TRANSFER", SourceAccountID: cash.ID, DestinationAccountID: paypal.ID, AmountMinor: 100, OccurredAt: "2026-09-04", Reason: "Internal transfer",
	})
	if err != nil || transfer.AmountMinor != -100 || transfer.CounterpartyAccountID != paypal.ID {
		t.Fatalf("create transfer: %#v err=%v", transfer, err)
	}

	reversal, err := service.ReverseTransaction(ctx, principal, membership, "reverse-expense-01", expense.ID, ReverseInput{Reason: "Wrong external purchase"})
	if err != nil || reversal.ReversalOf != expense.ID || reversal.AmountMinor != 150 {
		t.Fatalf("reverse expense: %#v err=%v", reversal, err)
	}
	incomeReversal, err := service.ReverseTransaction(ctx, principal, membership, "reverse-income-01", income.ID, ReverseInput{Reason: "Incorrect incoming amount"})
	if err != nil || incomeReversal.ReversalOf != income.ID {
		t.Fatalf("reverse income: %#v err=%v", incomeReversal, err)
	}
	newIncome, err := service.CreateTransaction(ctx, principal, membership, "new-income-01", CreateTransactionInput{Kind: "INCOME", DestinationAccountID: paypal.ID, AmountMinor: 300, OccurredAt: "2026-09-05", Reason: "New income"})
	if err != nil || newIncome.CorrectionOf != "" {
		t.Fatalf("create independent income: %#v err=%v", newIncome, err)
	}
	avatarKey := strings.Repeat("a", 64) + ".png"
	if _, err := database.ExecContext(ctx, `UPDATE users SET avatar_key=? WHERE id=(SELECT user_id FROM memberships WHERE id=?)`, avatarKey, membership.ID); err != nil {
		t.Fatalf("set transaction actor avatar: %v", err)
	}
	history, err := service.QueryTransactions(ctx, membership, TransactionQuery{AccountIDs: []string{cash.ID}, Sort: "occurredAt", Direction: "desc", Limit: 20})
	if err != nil || len(history.Items) < 5 {
		t.Fatalf("query transaction history: page=%#v err=%v", history, err)
	}
	for _, item := range history.Items {
		if item.Actor.ID == "" || item.Actor.DisplayName == "" || item.OccurredAt == "" || item.Status == "" || item.Source == "" {
			t.Fatalf("incomplete transaction projection: %#v", item)
		}
		if item.Actor.AvatarURL != "/api/v1/users/"+principal.UserID+"/avatar/"+avatarKey {
			t.Fatalf("transaction actor avatar missing: %#v", item.Actor)
		}
		if item.ID == income.ID && (item.ReversedByID != incomeReversal.ID || item.ReplacementID != "") {
			t.Fatalf("original reversal relationship is wrong: %#v", item)
		}
	}

	accounts, err = service.ListAccounts(ctx, membership)
	if err != nil {
		t.Fatal(err)
	}
	balances := map[string]int64{}
	for _, item := range accounts.Items {
		balances[item.ID] = item.BalanceMinor
	}
	if balances[cash.ID] != 900 || balances[paypal.ID] != 400 {
		t.Fatalf("balances=%v, want cash=900 paypal=400", balances)
	}
	if _, err := service.UpdateAccount(ctx, principal, membership, cash.ID, AccountInput{Name: cash.Name, Type: "OTHER"}, accounts.Version); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("type change after movement error=%v, want conflict", err)
	}

	ordered, err := service.ReorderAccounts(ctx, principal, membership, []string{paypal.ID, cash.ID}, accounts.Version)
	if err != nil || ordered.Items[0].ID != paypal.ID || ordered.Items[1].ID != cash.ID {
		t.Fatalf("swap order: %#v err=%v", ordered, err)
	}

	var metadata string
	if err := database.QueryRowContext(ctx, `SELECT group_concat(metadata_json,' ') FROM audit_events WHERE group_id=? AND action LIKE 'external_%'`, membership.GroupID).Scan(&metadata); err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"Secret Cash Name", "Secret PayPal Name", "SecretHandle", "Secret opening reason", "Secret opening reference", "Secret opening note", "Secret income reason", "Secret transaction reference", "Secret transaction note"} {
		if strings.Contains(metadata, secret) {
			t.Fatalf("audit metadata leaked %q: %s", secret, metadata)
		}
	}
}

func TestManualTransactionAttachmentsAreImmutableAndIdempotent(t *testing.T) {
	ctx, service, principal, membership, database := externalAccountFixture(t)
	accounts, err := service.CreateAccount(ctx, principal, membership, "attachment-account", 1, CreateAccountInput{AccountInput: AccountInput{Name: "Attachment cash", Type: "CASH"}})
	if err != nil {
		t.Fatal(err)
	}
	input := CreateTransactionInput{Kind: "INCOME", DestinationAccountID: accounts.Items[0].ID, AmountMinor: 250, OccurredAt: "2026-09-02", Reason: "Donation with evidence"}
	pdf := externalAccountTestPDF("original")
	created, err := service.CreateTransactionWithAttachment(ctx, principal, membership, "external-attachment-create", input, &TransactionAttachmentUpload{FileName: "evidence.pdf", Reader: bytes.NewReader(pdf), MaxBytes: 1 << 20})
	if err != nil || created.Attachment == nil || created.Attachment.FileName != "evidence.pdf" {
		t.Fatalf("create transaction attachment: transaction=%#v err=%v", created, err)
	}
	attachment, err := service.GetTransactionAttachment(ctx, membership, created.ID)
	if err != nil || attachment.Path == "" || attachment.SizeBytes <= 0 {
		t.Fatalf("get transaction attachment: attachment=%#v err=%v", attachment, err)
	}
	replayed, err := service.CreateTransactionWithAttachment(ctx, principal, membership, "external-attachment-create", input, &TransactionAttachmentUpload{FileName: "renamed.pdf", Reader: bytes.NewReader(pdf), MaxBytes: 1 << 20})
	if err != nil || !reflect.DeepEqual(replayed, created) {
		t.Fatalf("replay transaction attachment: replay=%#v err=%v", replayed, err)
	}
	if _, err := service.CreateTransactionWithAttachment(ctx, principal, membership, "external-attachment-create", input, &TransactionAttachmentUpload{FileName: "different.pdf", Reader: bytes.NewReader(externalAccountTestPDF("different")), MaxBytes: 1 << 20}); !errors.Is(err, domain.ErrIdempotencyReuse) {
		t.Fatalf("changed attachment replay error=%v, want idempotency reuse", err)
	}
	reversal, err := service.ReverseTransaction(ctx, principal, membership, "external-attachment-reverse", created.ID, ReverseInput{Reason: "Wrong donation"})
	if err != nil || reversal.Attachment != nil {
		t.Fatalf("reverse transaction attachment: reversal=%#v err=%v", reversal, err)
	}
	separate, err := service.CreateTransactionWithAttachment(ctx, principal, membership, "external-attachment-separate", CreateTransactionInput{Kind: "INCOME", DestinationAccountID: accounts.Items[0].ID, AmountMinor: 300, OccurredAt: "2026-09-03", Reason: "New donation"}, &TransactionAttachmentUpload{FileName: "new-evidence.pdf", Reader: bytes.NewReader(externalAccountTestPDF("replacement")), MaxBytes: 1 << 20})
	if err != nil || separate.Attachment == nil || separate.Attachment.FileName != "new-evidence.pdf" || separate.CorrectionOf != "" {
		t.Fatalf("create independent transaction attachment: transaction=%#v err=%v", separate, err)
	}
	if original, err := service.GetTransaction(ctx, membership, created.ID); err != nil || original.Attachment == nil || original.Attachment.FileName != "evidence.pdf" {
		t.Fatalf("reversal changed original attachment: transaction=%#v err=%v", original, err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE external_account_transaction_attachments SET original_filename='changed.pdf' WHERE transaction_id=?`, created.ID); err == nil {
		t.Fatal("external transaction attachment accepted an update")
	}
	if _, err := database.ExecContext(ctx, `DELETE FROM external_account_transaction_attachments WHERE transaction_id=?`, created.ID); err == nil {
		t.Fatal("external transaction attachment accepted a direct delete")
	}
}

func externalAccountTestPDF(marker string) []byte {
	prefix := fmt.Sprintf("%%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Marker (%s) >>\nendobj\n", marker)
	return []byte(fmt.Sprintf("%sxref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", prefix, len(prefix)))
}

func stringAddress(value string) *string { return &value }

func TestManualAccessRequiresEnabledFeature(t *testing.T) {
	ctx, service, principal, membership, database := externalAccountFixture(t)
	if _, err := database.ExecContext(ctx, `UPDATE group_settings SET external_accounts_enabled=0 WHERE group_id=?`, membership.GroupID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ListAccounts(ctx, membership); !errors.Is(err, domain.ErrExternalAccountsDisabled) {
		t.Fatalf("disabled list error=%v", err)
	}
	if _, err := service.CreateAccount(ctx, principal, membership, "", 0, CreateAccountInput{}); !errors.Is(err, domain.ErrExternalAccountsDisabled) {
		t.Fatalf("disabled invalid create-account error=%v, want disabled", err)
	}
	if _, err := service.CreateTransaction(ctx, principal, membership, "", CreateTransactionInput{}); !errors.Is(err, domain.ErrExternalAccountsDisabled) {
		t.Fatalf("disabled invalid create-transaction error=%v, want disabled", err)
	}
	if _, err := service.ReverseTransaction(ctx, principal, membership, "", "", ReverseInput{}); !errors.Is(err, domain.ErrExternalAccountsDisabled) {
		t.Fatalf("disabled invalid reverse error=%v, want disabled", err)
	}
}

func TestReplacePaymentMethodLinksValidatesCompleteAtomicMappingAndAuditContract(t *testing.T) {
	ctx, service, principal, membership, database := externalAccountFixture(t)
	accounts, err := service.CreateAccount(ctx, principal, membership, "link-audit-account", 1, CreateAccountInput{
		AccountInput: AccountInput{Name: "Audit cash", Type: "CASH"},
	})
	if err != nil {
		t.Fatal(err)
	}
	activeAccountID := accounts.Items[0].ID
	accounts, err = service.CreateAccount(ctx, principal, membership, "link-archived-account", accounts.Version, CreateAccountInput{
		AccountInput: AccountInput{Name: "Archived audit cash", Type: "CASH"},
	})
	if err != nil {
		t.Fatal(err)
	}
	archivedAccountID := accounts.Items[1].ID
	accounts, err = service.SetAccountArchived(ctx, principal, membership, archivedAccountID, true, accounts.Version)
	if err != nil {
		t.Fatal(err)
	}
	links, err := service.ListPaymentMethodLinks(ctx, membership)
	if err != nil || len(links.Links) < 2 {
		t.Fatalf("list payment-method links: links=%#v err=%v", links, err)
	}
	if links.Version != accounts.Version {
		t.Fatalf("link version=%d, want account collection version %d", links.Version, accounts.Version)
	}

	missing := append([]PaymentMethodLink(nil), links.Links[:len(links.Links)-1]...)
	if _, err := service.ReplacePaymentMethodLinks(ctx, principal, membership, ReplaceLinksInput{Links: missing}, links.Version); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("incomplete link set error=%v, want validation", err)
	}
	duplicate := append([]PaymentMethodLink(nil), links.Links...)
	duplicate[len(duplicate)-1].PaymentMethodID = duplicate[0].PaymentMethodID
	if _, err := service.ReplacePaymentMethodLinks(ctx, principal, membership, ReplaceLinksInput{Links: duplicate}, links.Version); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("duplicate payment-method error=%v, want validation", err)
	}
	blank := append([]PaymentMethodLink(nil), links.Links...)
	blank[0].ExternalAccountID = stringAddress("   ")
	if _, err := service.ReplacePaymentMethodLinks(ctx, principal, membership, ReplaceLinksInput{Links: blank}, links.Version); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("blank account ID error=%v, want validation", err)
	}
	archived := append([]PaymentMethodLink(nil), links.Links...)
	archived[0].ExternalAccountID = stringAddress(archivedAccountID)
	if _, err := service.ReplacePaymentMethodLinks(ctx, principal, membership, ReplaceLinksInput{Links: archived}, links.Version); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("archived account error=%v, want conflict", err)
	}
	rollback := append([]PaymentMethodLink(nil), links.Links...)
	rollback[0].ExternalAccountID = stringAddress(activeAccountID)
	rollback[len(rollback)-1].ExternalAccountID = stringAddress("exa_foreign")
	if _, err := service.ReplacePaymentMethodLinks(ctx, principal, membership, ReplaceLinksInput{Links: rollback}, links.Version); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("foreign account error=%v, want not found", err)
	}
	var version int64
	var linkedRows int
	if err := database.QueryRowContext(ctx, `SELECT external_accounts_version FROM group_settings WHERE group_id=?`, membership.GroupID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM group_payment_methods WHERE group_id=? AND external_account_id IS NOT NULL`, membership.GroupID).Scan(&linkedRows); err != nil {
		t.Fatal(err)
	}
	if version != links.Version || linkedRows != 0 {
		t.Fatalf("rejected replacements changed state: version=%d links=%d, want version=%d links=0", version, linkedRows, links.Version)
	}

	replacement := append([]PaymentMethodLink(nil), links.Links...)
	replacement[0].ExternalAccountID = stringAddress(activeAccountID)
	replacement[1].ExternalAccountID = stringAddress(activeAccountID)
	linked, err := service.ReplacePaymentMethodLinks(ctx, principal, membership, ReplaceLinksInput{Links: replacement}, links.Version)
	if err != nil {
		t.Fatal(err)
	}
	if linked.Version != links.Version+1 {
		t.Fatalf("replacement version=%d, want exactly %d", linked.Version, links.Version+1)
	}
	if _, err := service.ReplacePaymentMethodLinks(ctx, principal, membership, ReplaceLinksInput{Links: links.Links}, links.Version); !errors.Is(err, domain.ErrPrecondition) {
		t.Fatalf("stale replacement error=%v, want precondition", err)
	}
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM group_payment_methods WHERE group_id=? AND external_account_id=?`, membership.GroupID, activeAccountID).Scan(&linkedRows); err != nil {
		t.Fatal(err)
	}
	if linkedRows != 2 {
		t.Fatalf("linked payment methods=%d, want 2", linkedRows)
	}
	var action, metadataJSON string
	if err := database.QueryRowContext(ctx, `SELECT action,metadata_json FROM audit_events WHERE group_id=? AND action='external_account_links.replaced' ORDER BY occurred_at DESC,id DESC LIMIT 1`, membership.GroupID).Scan(&action, &metadataJSON); err != nil {
		t.Fatal(err)
	}
	if action != "external_account_links.replaced" {
		t.Fatalf("audit action=%q, want stable external_account_links.replaced", action)
	}
	var metadata map[string]any
	if err := json.Unmarshal([]byte(metadataJSON), &metadata); err != nil {
		t.Fatal(err)
	}
	if metadata["paymentMethodCount"] != float64(len(links.Links)) || metadata["linkedMethodCount"] != float64(2) {
		t.Fatalf("audit metadata=%v, want stable paymentMethodCount and linkedMethodCount", metadata)
	}
	if _, exists := metadata["linkedCount"]; exists {
		t.Fatalf("audit metadata unexpectedly contains renamed linkedCount key: %v", metadata)
	}
}

func TestArchiveAccountAtomicallyDetachesPaymentMethods(t *testing.T) {
	ctx, service, principal, membership, database := externalAccountFixture(t)
	accounts, err := service.CreateAccount(ctx, principal, membership, "archive-linked-account", 1, CreateAccountInput{
		AccountInput: AccountInput{Name: "Linked cash", Type: "CASH"},
	})
	if err != nil {
		t.Fatal(err)
	}
	accountID := accounts.Items[0].ID
	links, err := service.ListPaymentMethodLinks(ctx, membership)
	if err != nil || len(links.Links) < 2 {
		t.Fatalf("list payment-method links: links=%#v err=%v", links, err)
	}
	for index := range links.Links[:2] {
		links.Links[index].ExternalAccountID = stringAddress(accountID)
	}
	linked, err := service.ReplacePaymentMethodLinks(ctx, principal, membership, ReplaceLinksInput{Links: links.Links}, accounts.Version)
	if err != nil {
		t.Fatal(err)
	}
	listed, err := service.ListAccounts(ctx, membership)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Items) != 1 || !listed.Items[0].CanArchive || len(listed.Items[0].LinkedPaymentMethodIDs) != 2 {
		t.Fatalf("linked account lifecycle projection=%#v, want archiveable with two links", listed.Items)
	}

	if _, err := service.SetAccountArchived(ctx, principal, membership, accountID, true, accounts.Version); !errors.Is(err, domain.ErrPrecondition) {
		t.Fatalf("stale archive error=%v, want precondition", err)
	}
	var linkedRows int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM group_payment_methods WHERE group_id=? AND external_account_id=?`, membership.GroupID, accountID).Scan(&linkedRows); err != nil {
		t.Fatal(err)
	}
	if linkedRows != 2 {
		t.Fatalf("stale archive detached %d links, want 0", 2-linkedRows)
	}

	archived, err := service.SetAccountArchived(ctx, principal, membership, accountID, true, linked.Version)
	if err != nil {
		t.Fatal(err)
	}
	if archived.Version != linked.Version+1 || len(archived.Items) != 1 {
		t.Fatalf("archived collection=%#v, want one version increment", archived)
	}
	account := archived.Items[0]
	if account.Status != domain.ExternalAccountArchived || account.CanArchive || !account.CanReactivate || len(account.LinkedPaymentMethodIDs) != 0 {
		t.Fatalf("archived account projection=%#v", account)
	}
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM group_payment_methods WHERE group_id=? AND external_account_id=?`, membership.GroupID, accountID).Scan(&linkedRows); err != nil {
		t.Fatal(err)
	}
	if linkedRows != 0 {
		t.Fatalf("archived account retained %d payment-method links", linkedRows)
	}
	var metadataJSON string
	if err := database.QueryRowContext(ctx, `SELECT metadata_json FROM audit_events WHERE group_id=? AND action='external_account.archived' ORDER BY occurred_at DESC,id DESC LIMIT 1`, membership.GroupID).Scan(&metadataJSON); err != nil {
		t.Fatal(err)
	}
	var metadata map[string]any
	if err := json.Unmarshal([]byte(metadataJSON), &metadata); err != nil {
		t.Fatal(err)
	}
	if metadata["detachedPaymentMethodCount"] != float64(2) {
		t.Fatalf("archive audit metadata=%v, want detachedPaymentMethodCount=2", metadata)
	}
}

func TestCreateAccountRejectsOverflowingOpeningBalanceWithoutPersistingAccount(t *testing.T) {
	ctx, service, principal, membership, database := externalAccountFixture(t)
	_, err := service.CreateAccount(ctx, principal, membership, "overflow-opening-balance", 1, CreateAccountInput{
		AccountInput:   AccountInput{Name: "Must roll back", Type: "CASH"},
		OpeningBalance: &OpeningBalanceInput{AmountMinor: -1 << 63, OccurredAt: "2026-09-01", Reason: "Unsafe opening"},
	})
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("create account error=%v, want validation", err)
	}
	var count int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM external_accounts WHERE group_id=? AND name='Must roll back'`, membership.GroupID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("invalid opening persisted account: count=%d err=%v", count, err)
	}
}

func TestMutationProjectionReplayAndReversalUseCurrentOpenPeriod(t *testing.T) {
	ctx, service, principal, membership, database := externalAccountFixture(t)
	accounts, err := service.CreateAccount(ctx, principal, membership, "projected-account", 1, CreateAccountInput{AccountInput: AccountInput{Name: "Original cash", Type: "CASH"}})
	if err != nil {
		t.Fatal(err)
	}
	account := accounts.Items[0]
	input := CreateTransactionInput{Kind: "INCOME", DestinationAccountID: account.ID, AmountMinor: 250, OccurredAt: "2026-09-02", Reason: "Projected income"}
	created, err := service.CreateTransaction(ctx, principal, membership, "projected-income", input)
	if err != nil {
		t.Fatal(err)
	}
	if created.Status != "POSTED" || !created.CanReverse || created.Actor.ID != membership.ID || created.DestinationAccount == nil || created.DestinationAccount.Name != "Original cash" || len(created.Impacts) != 1 {
		t.Fatalf("incomplete mutation projection: %#v", created)
	}
	var originalPeriodID string
	if err := database.QueryRowContext(ctx, `SELECT period_id FROM ledger_entries WHERE group_id=? AND external_transaction_id=? AND account='EXTERNAL_ACCOUNT'`, membership.GroupID, created.ID).Scan(&originalPeriodID); err != nil {
		t.Fatal(err)
	}
	closedAt := "2026-09-03T00:00:00Z"
	if _, err := database.ExecContext(ctx, `UPDATE periods SET status='CLOSED',closed_at=? WHERE group_id=? AND id=?`, closedAt, membership.GroupID, originalPeriodID); err != nil {
		t.Fatal(err)
	}
	const currentPeriodID = "period-current-external"
	if _, err := database.ExecContext(ctx, `INSERT INTO periods(id,group_id,label,status,starts_at,created_at) VALUES(?,?,?,'OPEN',?,?)`, currentPeriodID, membership.GroupID, "Current external period", closedAt, closedAt); err != nil {
		t.Fatal(err)
	}
	reversal, err := service.ReverseTransaction(ctx, principal, membership, "projected-reversal", created.ID, ReverseInput{Reason: "Reverse in the current period"})
	if err != nil {
		t.Fatal(err)
	}
	if reversal.ReversalOfID != created.ID || reversal.Status != "POSTED" || len(reversal.Impacts) != 1 {
		t.Fatalf("incomplete reversal projection: %#v", reversal)
	}
	var reversalLegs, wrongPeriodLegs int
	if err := database.QueryRowContext(ctx, `SELECT count(*),sum(period_id<>?) FROM ledger_entries WHERE group_id=? AND external_transaction_id=?`, currentPeriodID, membership.GroupID, reversal.ID).Scan(&reversalLegs, &wrongPeriodLegs); err != nil {
		t.Fatal(err)
	}
	if reversalLegs != 2 || wrongPeriodLegs != 0 {
		t.Fatalf("reversal period legs=%d wrong=%d, want two current-period legs", reversalLegs, wrongPeriodLegs)
	}
	if _, err := service.UpdateAccount(ctx, principal, membership, account.ID, AccountInput{Name: "Renamed cash", Type: "CASH"}, accounts.Version); err != nil {
		t.Fatal(err)
	}
	replayed, err := service.CreateTransaction(ctx, principal, membership, "projected-income", input)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(replayed, created) {
		t.Fatalf("idempotency replay changed after later mutations:\ncreated=%#v\nreplayed=%#v", created, replayed)
	}
	fresh, err := service.GetTransaction(ctx, membership, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Status != "REVERSED" || fresh.DestinationAccount == nil || fresh.DestinationAccount.Name != "Renamed cash" {
		t.Fatalf("fresh projection did not reflect later state: %#v", fresh)
	}
}

func TestStatusCursorPaginationIsStableInBothDirections(t *testing.T) {
	ctx, service, principal, membership, _ := externalAccountFixture(t)
	accounts, err := service.CreateAccount(ctx, principal, membership, "status-cursor-account", 1, CreateAccountInput{AccountInput: AccountInput{Name: "Cursor cash", Type: "CASH"}})
	if err != nil {
		t.Fatal(err)
	}
	accountID := accounts.Items[0].ID
	var transactions []TransactionView
	for index, amount := range []int64{100, 200, 300} {
		transaction, err := service.CreateTransaction(ctx, principal, membership, fmt.Sprintf("cursor-income-%d", index), CreateTransactionInput{Kind: "INCOME", DestinationAccountID: accountID, AmountMinor: amount, OccurredAt: "2026-09-02", Reason: fmt.Sprintf("Cursor income %d", index)})
		if err != nil {
			t.Fatal(err)
		}
		transactions = append(transactions, transaction)
	}
	if _, err := service.ReverseTransaction(ctx, principal, membership, "cursor-reversal", transactions[1].ID, ReverseInput{Reason: "Create mixed statuses"}); err != nil {
		t.Fatal(err)
	}
	for _, direction := range []string{"asc", "desc"} {
		expectedPage, err := service.QueryTransactions(ctx, membership, TransactionQuery{Sort: "status", Direction: direction, Limit: 200})
		if err != nil {
			t.Fatal(err)
		}
		expectedIDs := make([]string, 0, len(expectedPage.Items))
		for _, item := range expectedPage.Items {
			expectedIDs = append(expectedIDs, item.ID)
		}
		var actualIDs []string
		cursor := ""
		for pageNumber := 0; pageNumber <= len(expectedIDs); pageNumber++ {
			page, err := service.QueryTransactions(ctx, membership, TransactionQuery{Sort: "status", Direction: direction, Cursor: cursor, Limit: 1})
			if err != nil {
				t.Fatalf("direction=%s page=%d: %v", direction, pageNumber, err)
			}
			for _, item := range page.Items {
				actualIDs = append(actualIDs, item.ID)
			}
			if page.NextCursor == "" {
				break
			}
			cursor = page.NextCursor
		}
		if !reflect.DeepEqual(actualIDs, expectedIDs) {
			t.Fatalf("direction=%s paginated IDs=%v, want %v", direction, actualIDs, expectedIDs)
		}
	}
}

func TestAccountBalanceOverflowIsRejectedWithoutPartialWrites(t *testing.T) {
	ctx, service, principal, membership, database := externalAccountFixture(t)
	accounts, err := service.CreateAccount(ctx, principal, membership, "overflow-positive-account", 1, CreateAccountInput{AccountInput: AccountInput{Name: "Positive limit", Type: "CASH"}})
	if err != nil {
		t.Fatal(err)
	}
	positiveID := accounts.Items[0].ID
	accounts, err = service.CreateAccount(ctx, principal, membership, "overflow-negative-account", accounts.Version, CreateAccountInput{AccountInput: AccountInput{Name: "Negative limit", Type: "CASH"}})
	if err != nil {
		t.Fatal(err)
	}
	negativeID := ""
	for _, account := range accounts.Items {
		if account.Name == "Negative limit" {
			negativeID = account.ID
		}
	}
	if err := storage.WithTx(ctx, database, func(tx *sql.Tx) error {
		if _, err := createManualTransactionTx(ctx, tx, membership, normalizedTransactionInput{Kind: "INCOME", PrimaryAccountID: positiveID, AmountMinor: math.MaxInt64 - 5, BookedAt: "2026-09-02T00:00:00Z", Reason: "Positive boundary"}, nil); err != nil {
			return err
		}
		_, err := createManualTransactionTx(ctx, tx, membership, normalizedTransactionInput{Kind: "EXPENSE", PrimaryAccountID: negativeID, AmountMinor: math.MinInt64 + 5, BookedAt: "2026-09-02T00:00:00Z", Reason: "Negative boundary"}, nil)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateTransaction(ctx, principal, membership, "overflow-positive", CreateTransactionInput{Kind: "INCOME", DestinationAccountID: positiveID, AmountMinor: 10, OccurredAt: "2026-09-03", Reason: "Must overflow positively"}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("positive overflow error=%v, want conflict", err)
	}
	if _, err := service.CreateTransaction(ctx, principal, membership, "overflow-negative", CreateTransactionInput{Kind: "EXPENSE", SourceAccountID: negativeID, AmountMinor: 10, OccurredAt: "2026-09-03", Reason: "Must overflow negatively"}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("negative overflow error=%v, want conflict", err)
	}
	var rejected int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM external_account_transactions WHERE group_id=? AND reason LIKE 'Must overflow%'`, membership.GroupID).Scan(&rejected); err != nil {
		t.Fatal(err)
	}
	if rejected != 0 {
		t.Fatalf("overflowing transactions partially persisted: %d", rejected)
	}
	listed, err := service.ListAccounts(ctx, membership)
	if err != nil {
		t.Fatal(err)
	}
	balances := map[string]int64{}
	for _, account := range listed.Items {
		balances[account.ID] = account.BalanceMinor
	}
	if balances[positiveID] != math.MaxInt64-5 || balances[negativeID] != math.MinInt64+5 {
		t.Fatalf("balances changed after rejected writes: %v", balances)
	}
}

func TestDeleteAccountUsesPhysicalOrHistoricalRemovalAndReversalRestoresBalance(t *testing.T) {
	ctx, service, principal, membership, database := externalAccountFixture(t)

	accounts, err := service.CreateAccount(ctx, principal, membership, "create-unused-delete-account", 1, CreateAccountInput{AccountInput: AccountInput{Name: "Unused cash", Type: "CASH"}})
	if err != nil {
		t.Fatal(err)
	}
	unusedID := accounts.Items[0].ID
	if accounts.Items[0].CanDelete {
		t.Fatalf("active unused account is deleteable: %#v", accounts.Items[0])
	}
	if _, err := service.DeleteAccount(ctx, principal, membership, unusedID, accounts.Version); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("delete active unused account error=%v, want conflict", err)
	}
	accounts, err = service.SetAccountArchived(ctx, principal, membership, unusedID, true, accounts.Version)
	if err != nil || len(accounts.Items) != 1 || !accounts.Items[0].CanDelete {
		t.Fatalf("archive unused account: accounts=%#v err=%v", accounts, err)
	}
	accounts, err = service.DeleteAccount(ctx, principal, membership, unusedID, accounts.Version)
	if err != nil || len(accounts.Items) != 0 {
		t.Fatalf("physically delete unused account: accounts=%#v err=%v", accounts, err)
	}
	var unusedRows int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM external_accounts WHERE id=?`, unusedID).Scan(&unusedRows); err != nil || unusedRows != 0 {
		t.Fatalf("unused account rows=%d err=%v, want physical deletion", unusedRows, err)
	}

	accounts, err = service.CreateAccount(ctx, principal, membership, "create-historical-delete-account", accounts.Version, CreateAccountInput{AccountInput: AccountInput{Name: "Seasonal cash", Type: "CASH"}})
	if err != nil {
		t.Fatal(err)
	}
	accountID := accounts.Items[0].ID
	income, err := service.CreateTransaction(ctx, principal, membership, "historical-delete-income", CreateTransactionInput{Kind: "INCOME", DestinationAccountID: accountID, AmountMinor: 500, OccurredAt: "2026-09-10", Reason: "Season income"})
	if err != nil {
		t.Fatal(err)
	}
	expense, err := service.CreateTransaction(ctx, principal, membership, "historical-delete-expense", CreateTransactionInput{Kind: "EXPENSE", SourceAccountID: accountID, AmountMinor: 500, OccurredAt: "2026-09-11", Reason: "Season expense"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.DeleteAccount(ctx, principal, membership, accountID, accounts.Version); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("delete active used account error=%v, want conflict", err)
	}
	archived, err := service.SetAccountArchived(ctx, principal, membership, accountID, true, accounts.Version)
	if err != nil || len(archived.Items) != 1 || archived.Items[0].BalanceMinor != 0 || !archived.Items[0].CanDelete {
		t.Fatalf("archive balanced account: accounts=%#v err=%v", archived, err)
	}
	removed, err := service.DeleteAccount(ctx, principal, membership, accountID, archived.Version)
	if err != nil || len(removed.Items) != 0 {
		t.Fatalf("historically delete balanced account: accounts=%#v err=%v", removed, err)
	}
	var deletedAt sql.NullString
	var status string
	if err := database.QueryRowContext(ctx, `SELECT status,deleted_at FROM external_accounts WHERE id=?`, accountID).Scan(&status, &deletedAt); err != nil || status != statusArchived || !deletedAt.Valid {
		t.Fatalf("historical identity status=%q deletedAt=%#v err=%v", status, deletedAt, err)
	}
	search, err := service.QueryTransactions(ctx, membership, TransactionQuery{Search: "Seasonal cash", Limit: 20})
	if err != nil || len(search.Items) != 2 {
		t.Fatalf("search deleted account history: page=%#v err=%v", search, err)
	}
	if search.Items[0].SourceAccount == nil && search.Items[0].DestinationAccount == nil {
		t.Fatalf("deleted account identity missing from history: %#v", search.Items[0])
	}
	var deletionMetadata string
	if err := database.QueryRowContext(ctx, `SELECT metadata_json FROM audit_events WHERE group_id=? AND action='external_account.deleted' AND resource_id=? ORDER BY occurred_at DESC,id DESC LIMIT 1`, membership.GroupID, accountID).Scan(&deletionMetadata); err != nil || !strings.Contains(deletionMetadata, `"mode":"historical"`) {
		t.Fatalf("historical deletion audit metadata=%q err=%v", deletionMetadata, err)
	}

	reversal, err := service.ReverseTransaction(ctx, principal, membership, "restore-historical-account", expense.ID, ReverseInput{Reason: "Restore outstanding season expense"})
	if err != nil || reversal.ReversalOfID != expense.ID {
		t.Fatalf("reverse after historical deletion: reversal=%#v err=%v", reversal, err)
	}
	restored, err := service.ListAccounts(ctx, membership)
	if err != nil || len(restored.Items) != 1 {
		t.Fatalf("list automatically restored account: accounts=%#v err=%v", restored, err)
	}
	if restored.Items[0].ID != accountID || restored.Items[0].Status != domain.ExternalAccountArchived || restored.Items[0].BalanceMinor != 500 || restored.Items[0].CanDelete {
		t.Fatalf("restored account projection=%#v", restored.Items[0])
	}
	if _, err := service.DeleteAccount(ctx, principal, membership, accountID, restored.Version); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("delete restored non-zero account error=%v, want conflict", err)
	}
	var restorationActor, restorationMembership string
	if err := database.QueryRowContext(ctx, `SELECT actor_user_id,actor_membership_id FROM audit_events WHERE group_id=? AND action='external_account.restored_after_reversal' AND resource_id=?`, membership.GroupID, accountID).Scan(&restorationActor, &restorationMembership); err != nil {
		t.Fatalf("read restoration audit: %v", err)
	}
	if restorationActor != principal.UserID || restorationMembership != membership.ID {
		t.Fatalf("restoration actor=%q membership=%q", restorationActor, restorationMembership)
	}
	if income.ID == "" {
		t.Fatal("income fixture was not persisted")
	}
}

func externalAccountFixture(t *testing.T) (context.Context, Service, domain.Principal, domain.Membership, *sql.DB) {
	t.Helper()
	ctx := context.Background()
	dataDirectory := t.TempDir()
	database, err := storage.Open(ctx, filepath.Join(dataDirectory, "external-accounts.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
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
	now := "2026-09-01T00:00:00Z"
	if _, err := database.ExecContext(ctx, `INSERT INTO membership_role_assignments(group_id,membership_id,role_id,version,assigned_at) VALUES(?,?,?,1,?)`, membership.GroupID, membership.ID, "role:FINANCE_MANAGER:"+membership.GroupID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE group_settings SET external_accounts_enabled=1 WHERE group_id=?`, membership.GroupID); err != nil {
		t.Fatal(err)
	}
	return ctx, Service{DB: database, Attachments: paymentattachments.Store{DataDirectory: dataDirectory}}, session.Principal, membership, database
}
