package storage

import (
	"context"
	"database/sql"
	"testing"
)

func TestExternalAccountsMigrationMovesPaymentTargetsToSingleSourceAccounts(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0044_payment_targets.sql")
	defer db.Close()
	const now = "2026-08-27T12:00:00Z"
	if _, err := db.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at)
		VALUES('group-one','One Group','EUR',?,?)`, now, now); err != nil {
		t.Fatalf("insert pre-migration group: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO group_settings(group_id,updated_at) VALUES('group-one',?)`, now); err != nil {
		t.Fatalf("insert pre-migration settings: %v", err)
	}
	for _, statement := range []string{
		`UPDATE group_payment_methods SET attachment_mode='OPTIONAL',payment_target_type='PAYPAL_ME',paypal_me_handle='Club123' WHERE group_id='group-one' AND id='PAYPAL'`,
		`UPDATE group_payment_methods SET payment_target_type='PAYPAL_ME',paypal_me_handle='Club123' WHERE group_id='group-one' AND id='OTHER'`,
		`UPDATE group_payment_methods SET payment_target_type='SEPA_TRANSFER',sepa_recipient_name='Team Club',sepa_iban='DE89370400440532013000',sepa_bic='COBADEFFXXX' WHERE group_id='group-one' AND id='BANK_TRANSFER'`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("prepare payment target: %v", err)
		}
	}
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply external-account migration: %v", err)
	}

	var accountCount, linkedCount, paypalLinkCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM external_accounts WHERE group_id='group-one'`).Scan(&accountCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM group_payment_methods WHERE group_id='group-one' AND external_account_id IS NOT NULL`).Scan(&linkedCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(DISTINCT external_account_id) FROM group_payment_methods WHERE group_id='group-one' AND id IN ('PAYPAL','OTHER')`).Scan(&paypalLinkCount); err != nil {
		t.Fatal(err)
	}
	if accountCount != 2 || linkedCount != 3 || paypalLinkCount != 1 {
		t.Fatalf("accounts/links/distinct PayPal links=%d/%d/%d, want 2/3/1", accountCount, linkedCount, paypalLinkCount)
	}
	var financeImplications, manageImplications string
	if err := db.QueryRowContext(ctx, `SELECT implied_permissions_json FROM permission_definitions WHERE key='FINANCE_MANAGEMENT'`).Scan(&financeImplications); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT implied_permissions_json FROM permission_definitions WHERE key='MANAGE_EXTERNAL_ACCOUNTS'`).Scan(&manageImplications); err != nil {
		t.Fatal(err)
	}
	if financeImplications != `["MANAGE_EXTERNAL_ACCOUNTS"]` || manageImplications != `["VIEW_EXTERNAL_ACCOUNTS"]` {
		t.Fatalf("external-account implications=%s/%s", financeImplications, manageImplications)
	}
	var attachmentMode, accountType, handle string
	if err := db.QueryRowContext(ctx, `SELECT method.attachment_mode,account.type,account.paypal_me_handle
		FROM group_payment_methods method JOIN external_accounts account
		ON account.group_id=method.group_id AND account.id=method.external_account_id
		WHERE method.group_id='group-one' AND method.id='PAYPAL'`).Scan(&attachmentMode, &accountType, &handle); err != nil {
		t.Fatalf("read migrated PayPal method: %v", err)
	}
	if attachmentMode != "OPTIONAL" || accountType != "PAYPAL" || handle != "Club123" {
		t.Fatalf("migrated PayPal method=%q/%q/%q", attachmentMode, accountType, handle)
	}

	invalidStatements := []string{
		`INSERT INTO external_accounts(id,group_id,name,type,sort_order,created_at,updated_at) VALUES('bad-bank','group-one','Bad bank','BANK',10,'2026-08-27T12:00:00Z','2026-08-27T12:00:00Z')`,
		`INSERT INTO external_accounts(id,group_id,name,type,sort_order,paypal_me_handle,created_at,updated_at) VALUES('bad-paypal','group-one','Bad PayPal','PAYPAL',11,'bad-handle','2026-08-27T12:00:00Z','2026-08-27T12:00:00Z')`,
		`INSERT INTO external_accounts(id,group_id,name,type,sort_order,sepa_recipient_name,sepa_iban,created_at,updated_at) VALUES('bad-cash','group-one','Bad cash','CASH',12,'Team','DE89370400440532013000','2026-08-27T12:00:00Z','2026-08-27T12:00:00Z')`,
		`INSERT INTO external_accounts(id,group_id,name,type,sort_order,created_at,updated_at) VALUES('bad-type','group-one','Bad type','UNKNOWN',13,'2026-08-27T12:00:00Z','2026-08-27T12:00:00Z')`,
	}
	for index, statement := range invalidStatements {
		if _, err := db.ExecContext(ctx, statement); err == nil {
			t.Fatalf("invalid external account shape %d unexpectedly passed", index)
		}
	}

	if _, err := db.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at)
		VALUES('group-two','Two Group','EUR',?,?)`, now, now); err != nil {
		t.Fatalf("insert post-migration group: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO group_settings(group_id,updated_at) VALUES('group-two',?)`, now); err != nil {
		t.Fatalf("insert post-migration settings: %v", err)
	}
	var seededCount, seededUnlinked int
	if err := db.QueryRowContext(ctx, `SELECT count(*),sum(external_account_id IS NULL) FROM group_payment_methods WHERE group_id='group-two'`).Scan(&seededCount, &seededUnlinked); err != nil {
		t.Fatalf("read post-migration methods: %v", err)
	}
	if seededCount != 5 || seededUnlinked != 5 {
		t.Fatalf("post-migration methods/unlinked=%d/%d, want 5/5", seededCount, seededUnlinked)
	}
	var featureEnabled bool
	var collectionVersion int64
	if err := db.QueryRowContext(ctx, `SELECT external_accounts_enabled,external_accounts_version FROM group_settings WHERE group_id='group-two'`).Scan(&featureEnabled, &collectionVersion); err != nil {
		t.Fatal(err)
	}
	if featureEnabled || collectionVersion != 1 {
		t.Fatalf("external account settings enabled/version=%t/%d, want false/1", featureEnabled, collectionVersion)
	}
	for _, tableName := range []string{"external_accounts", "external_account_transactions", "external_account_transaction_attachments"} {
		var count int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?`, tableName).Scan(&count); err != nil || count != 1 {
			t.Fatalf("table %s count=%d err=%v, want 1", tableName, count, err)
		}
	}
	assertNoForeignKeyViolations(t, ctx, db)
}

func TestExternalAccountsMigrationPreservesDistinctBankTargetsWithSharedIBAN(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0044_payment_targets.sql")
	defer db.Close()
	const now = "2026-08-27T12:00:00Z"
	if _, err := db.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-one','One Group','EUR',?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO group_settings(group_id,updated_at) VALUES('group-one',?)`, now); err != nil {
		t.Fatal(err)
	}
	for _, target := range []struct{ methodID, recipient, bic string }{
		{"BANK_TRANSFER", "Main club", "COBADEFFXXX"},
		{"OTHER", "Youth club", "DEUTDEFFXXX"},
	} {
		if _, err := db.ExecContext(ctx, `UPDATE group_payment_methods SET payment_target_type='SEPA_TRANSFER',sepa_recipient_name=?,sepa_iban='DE89370400440532013000',sepa_bic=? WHERE group_id='group-one' AND id=?`, target.recipient, target.bic, target.methodID); err != nil {
			t.Fatalf("prepare %s target: %v", target.methodID, err)
		}
	}
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply external-account migration: %v", err)
	}
	for _, target := range []struct{ methodID, recipient, bic string }{
		{"BANK_TRANSFER", "Main club", "COBADEFFXXX"},
		{"OTHER", "Youth club", "DEUTDEFFXXX"},
	} {
		var recipient, iban, bic string
		if err := db.QueryRowContext(ctx, `SELECT account.sepa_recipient_name,account.sepa_iban,account.sepa_bic FROM group_payment_methods method JOIN external_accounts account ON account.group_id=method.group_id AND account.id=method.external_account_id WHERE method.group_id='group-one' AND method.id=?`, target.methodID).Scan(&recipient, &iban, &bic); err != nil {
			t.Fatalf("read %s target: %v", target.methodID, err)
		}
		if recipient != target.recipient || iban != "DE89370400440532013000" || bic != target.bic {
			t.Fatalf("%s target = %q/%q/%q", target.methodID, recipient, iban, bic)
		}
	}
	var accountCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM external_accounts WHERE group_id='group-one' AND sepa_iban='DE89370400440532013000'`).Scan(&accountCount); err != nil || accountCount != 2 {
		t.Fatalf("distinct bank account count=%d err=%v, want two", accountCount, err)
	}
}

func TestExternalAccountBankTargetIndexUpgradesAlreadyMigratedDatabase(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0055_external_account_attachments.sql")
	defer db.Close()
	const now = "2026-08-27T12:00:00Z"
	for _, statement := range []string{
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-one','One Group','EUR','2026-08-27T12:00:00Z','2026-08-27T12:00:00Z')`,
		`INSERT INTO group_settings(group_id,updated_at) VALUES('group-one','2026-08-27T12:00:00Z')`,
		`DROP INDEX external_accounts_group_bank_target_idx`,
		`CREATE UNIQUE INDEX external_accounts_group_iban_idx ON external_accounts(group_id,sepa_iban) WHERE sepa_iban IS NOT NULL`,
		`INSERT INTO external_accounts(id,group_id,name,type,sort_order,sepa_recipient_name,sepa_iban,sepa_bic,created_at,updated_at) VALUES('bank-one','group-one','Main bank','BANK',0,'Main club','DE89370400440532013000','COBADEFFXXX','2026-08-27T12:00:00Z','2026-08-27T12:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("prepare previously migrated schema: %v", err)
		}
	}
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("upgrade previously migrated schema: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO external_accounts(id,group_id,name,type,sort_order,sepa_recipient_name,sepa_iban,sepa_bic,created_at,updated_at) VALUES('bank-two','group-one','Youth bank','BANK',1,'Youth club','DE89370400440532013000','DEUTDEFFXXX',?,?)`, now, now); err != nil {
		t.Fatalf("distinct target with shared IBAN must be permitted after upgrade: %v", err)
	}
	var obsoleteIndexCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type='index' AND name='external_accounts_group_iban_idx'`).Scan(&obsoleteIndexCount); err != nil || obsoleteIndexCount != 0 {
		t.Fatalf("obsolete IBAN-only index count=%d err=%v", obsoleteIndexCount, err)
	}
	assertNoForeignKeyViolations(t, ctx, db)
}

func TestExternalAccountAttachmentsMigrationUpgradesSchema0054(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0054_external_accounts.sql")
	defer db.Close()

	var count int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='external_account_transaction_attachments'`).Scan(&count); err != nil {
		t.Fatalf("inspect pre-migration attachment table: %v", err)
	}
	if count != 0 {
		t.Fatalf("pre-migration attachment table count=%d, want 0", count)
	}
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply external-account attachment migration: %v", err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='external_account_transaction_attachments'`).Scan(&count); err != nil {
		t.Fatalf("inspect migrated attachment table: %v", err)
	}
	if count != 1 {
		t.Fatalf("migrated attachment table count=%d, want 1", count)
	}
	assertNoForeignKeyViolations(t, ctx, db)
}

func TestExternalAccountSafeDeletionMigrationKeepsExistingAccountsVisible(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0056_external_account_bank_target_identity.sql")
	defer db.Close()

	if _, err := db.ExecContext(ctx, `INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('safe-delete-user','safe-delete@example.test','Safe Delete','hash','2026-09-22T10:00:00Z','2026-09-22T10:00:00Z')`); err != nil {
		t.Fatalf("insert user fixture: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('safe-delete-group','Safe Delete','EUR','2026-09-22T10:00:00Z','2026-09-22T10:00:00Z')`); err != nil {
		t.Fatalf("insert group fixture: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO group_settings(group_id,external_accounts_enabled,updated_at) VALUES('safe-delete-group',1,'2026-09-22T10:00:00Z')`); err != nil {
		t.Fatalf("insert settings fixture: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('safe-delete-member','safe-delete-group','safe-delete-user','ACTIVE','2026-09-22T10:00:00Z')`); err != nil {
		t.Fatalf("insert membership fixture: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO external_accounts(id,group_id,name,type,status,sort_order,version,created_at,updated_at) VALUES('safe-delete-account','safe-delete-group','Historical cash','CASH','ARCHIVED',0,1,'2026-09-22T10:00:00Z','2026-09-22T10:00:00Z')`); err != nil {
		t.Fatalf("insert account fixture: %v", err)
	}

	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply safe-deletion migration: %v", err)
	}
	var deletedAt sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT deleted_at FROM external_accounts WHERE id='safe-delete-account'`).Scan(&deletedAt); err != nil {
		t.Fatalf("read migrated account: %v", err)
	}
	if deletedAt.Valid {
		t.Fatalf("existing account unexpectedly tombstoned at %q", deletedAt.String)
	}
	var indexCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type='index' AND name='external_accounts_group_visibility_status_order_idx'`).Scan(&indexCount); err != nil || indexCount != 1 {
		t.Fatalf("visibility index count=%d err=%v", indexCount, err)
	}
	assertNoForeignKeyViolations(t, ctx, db)
}

func TestExternalAccountsMigrationPreservesLedgerAndGuardsNewRows(t *testing.T) {
	ctx := context.Background()
	db := openDatabaseThroughMigration(t, "0053_legal_documents.sql")
	defer db.Close()
	for _, statement := range []string{
		`INSERT INTO users(id,email,display_name,password_hash,created_at,updated_at) VALUES('user-one','one@example.test','One','hash','2026-08-27T12:00:00Z','2026-08-27T12:00:00Z')`,
		`INSERT INTO groups(id,name,currency,created_at,updated_at) VALUES('group-one','One','EUR','2026-08-27T12:00:00Z','2026-08-27T12:00:00Z')`,
		`INSERT INTO group_settings(group_id,updated_at) VALUES('group-one','2026-08-27T12:00:00Z')`,
		`INSERT INTO memberships(id,group_id,user_id,status,joined_at) VALUES('member-one','group-one','user-one','ACTIVE','2026-08-27T12:00:00Z')`,
		`INSERT INTO periods(id,group_id,label,status,starts_at,created_at) VALUES('period-one','group-one','Open','OPEN','2026-08-27T12:00:00Z','2026-08-27T12:00:00Z')`,
		`INSERT INTO ledger_entries(id,group_id,period_id,membership_id,account,amount_minor,description,created_at) VALUES('ledger-one','group-one','period-one','member-one','MEMBER_RECEIVABLE',125,'Existing','2026-08-27T12:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("prepare ledger fixture: %v", err)
		}
	}
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("apply external-account migration: %v", err)
	}
	var amount int64
	if err := db.QueryRowContext(ctx, `SELECT amount_minor FROM ledger_entries WHERE id='ledger-one' AND external_account_id IS NULL AND external_transaction_id IS NULL`).Scan(&amount); err != nil || amount != 125 {
		t.Fatalf("preserved ledger amount=%d err=%v, want 125", amount, err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE ledger_entries SET description='Changed' WHERE id='ledger-one'`); err == nil {
		t.Fatal("migrated ledger entry accepted an update")
	}
	for _, indexName := range []string{"ledger_member_movements_page_idx", "ledger_statistics_group_account_created_idx", "ledger_external_account_created_idx", "ledger_external_transaction_idx"} {
		var count int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type='index' AND name=?`, indexName).Scan(&count); err != nil || count != 1 {
			t.Fatalf("index %s count=%d err=%v, want 1", indexName, count, err)
		}
	}
	for _, statement := range []string{
		`INSERT INTO external_accounts(id,group_id,name,type,status,sort_order,version,created_at,updated_at,created_by_membership_id,updated_by_membership_id) VALUES('account-one','group-one','Cash','CASH','ACTIVE',0,1,'2026-08-27T12:00:00Z','2026-08-27T12:00:00Z','member-one','member-one')`,
		`INSERT INTO payments(id,group_id,membership_id,amount_minor,received_at,method,method_label,created_by,created_at) VALUES('payment-one','group-one','member-one',500,'2026-08-27T12:00:00Z','CASH','Cash','member-one','2026-08-27T12:00:00Z')`,
		`INSERT INTO external_account_transactions(id,group_id,kind,primary_account_id,payment_id,amount_minor,booked_at,created_by_membership_id,created_at) VALUES('transaction-payment','group-one','PAYMENT','account-one','payment-one',500,'2026-08-27T12:00:00Z','member-one','2026-08-27T12:00:00Z')`,
		`INSERT INTO external_account_transactions(id,group_id,kind,primary_account_id,payment_id,amount_minor,booked_at,reason,reversal_of,created_by_membership_id,created_at) VALUES('transaction-reversal','group-one','REVERSAL','account-one','payment-one',-500,'2026-08-28T12:00:00Z','Correction','transaction-payment','member-one','2026-08-28T12:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("insert payment-linked reversal fixture: %v", err)
		}
	}
	assertNoForeignKeyViolations(t, ctx, db)
}

func assertNoForeignKeyViolations(t *testing.T, ctx context.Context, db interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}) {
	t.Helper()
	rows, err := db.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatalf("check foreign keys: %v", err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Fatal("migration left a foreign-key violation")
	}
}
