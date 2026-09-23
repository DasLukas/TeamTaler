package statistics

import (
	"testing"

	"github.com/DasLukas/TeamTaler/internal/domain"
)

func TestExternalAccountStatisticsRequiresFeatureAndPermissionAndReconcilesBalances(t *testing.T) {
	fixture := newStatisticsFixture(t)
	fixture.enableStatistics(t, false)
	fixture.grant(t, domain.PermissionViewStatistics)
	groupID, membershipID := fixture.membership.GroupID, fixture.membership.ID
	const created = "2026-07-01T00:00:00Z"
	if _, err := fixture.db.ExecContext(fixture.ctx, `INSERT INTO external_accounts(id,group_id,name,type,status,sort_order,version,created_at,updated_at)
		VALUES('account-statistics',?,'Team cash','CASH','ACTIVE',0,1,?,?)`, groupID, created, created); err != nil {
		t.Fatalf("insert external account: %v", err)
	}
	for _, item := range []struct {
		id, kind, at string
		amount       int64
	}{
		{"opening", "OPENING_BALANCE", "2026-07-15T12:00:00Z", 10000},
		{"income", "INCOME", "2026-08-05T12:00:00Z", 2500},
		{"expense", "EXPENSE", "2026-08-12T12:00:00Z", -5000},
	} {
		if _, err := fixture.db.ExecContext(fixture.ctx, `INSERT INTO external_account_transactions(id,group_id,kind,primary_account_id,amount_minor,booked_at,created_by_membership_id,created_at)
			VALUES(?,?,?,?,?,?,?,?)`, item.id, groupID, item.kind, "account-statistics", absMinor(item.amount), item.at, membershipID, item.at); err != nil {
			t.Fatalf("insert external transaction %s: %v", item.id, err)
		}
		if _, err := fixture.db.ExecContext(fixture.ctx, `INSERT INTO ledger_entries(id,group_id,external_account_id,external_transaction_id,account,amount_minor,description,created_at)
			VALUES(?,?,?,?,'EXTERNAL_ACCOUNT',?,'Statistics test',?)`, "entry-"+item.id, groupID, "account-statistics", item.id, item.amount, item.at); err != nil {
			t.Fatalf("insert external ledger entry %s: %v", item.id, err)
		}
	}
	query := Query{Preset: PresetCustom, From: "2026-08-01", To: "2026-08-31"}
	service := fixture.service()
	withoutFeature, err := service.Dashboard(fixture.ctx, fixture.membership, query)
	if err != nil || withoutFeature.ExternalAccounts != nil {
		t.Fatalf("disabled external statistics=%#v err=%v", withoutFeature.ExternalAccounts, err)
	}
	if _, err := fixture.db.ExecContext(fixture.ctx, `UPDATE group_settings SET external_accounts_enabled=1 WHERE group_id=?`, groupID); err != nil {
		t.Fatalf("enable external accounts: %v", err)
	}
	if _, err := fixture.db.ExecContext(fixture.ctx, `DELETE FROM role_permission_grants WHERE group_id=? AND permission_key IN ('FINANCE_MANAGEMENT','MANAGE_EXTERNAL_ACCOUNTS','VIEW_EXTERNAL_ACCOUNTS')`, groupID); err != nil {
		t.Fatalf("remove external account grants: %v", err)
	}
	withoutPermission, err := service.Dashboard(fixture.ctx, fixture.membership, query)
	if err != nil || withoutPermission.ExternalAccounts != nil {
		t.Fatalf("ungranted external statistics=%#v err=%v", withoutPermission.ExternalAccounts, err)
	}
	fixture.grant(t, domain.PermissionViewExternalAccounts)
	dashboard, err := service.Dashboard(fixture.ctx, fixture.membership, query)
	if err != nil {
		t.Fatalf("read authorized external statistics: %v", err)
	}
	if dashboard.ExternalAccounts == nil || len(dashboard.ExternalAccounts.Accounts) != 1 {
		t.Fatalf("external account section=%#v", dashboard.ExternalAccounts)
	}
	account := dashboard.ExternalAccounts.Accounts[0]
	if account.OpeningBalanceMinor != 10000 || account.ClosingBalanceMinor != 7500 {
		t.Fatalf("account balances=%d -> %d, want 10000 -> 7500", account.OpeningBalanceMinor, account.ClosingBalanceMinor)
	}
	if len(account.Series) != 31 || account.Series[4].ClosingBalanceMinor != 12500 || account.Series[11].ClosingBalanceMinor != 7500 || account.Series[30].ClosingBalanceMinor != 7500 {
		t.Fatalf("account series did not carry correct daily closing balances: %#v", account.Series)
	}
	if _, err := fixture.db.ExecContext(fixture.ctx, `UPDATE external_accounts SET status='ARCHIVED',deleted_at='2026-09-22T12:00:00Z' WHERE group_id=? AND id='account-statistics'`, groupID); err != nil {
		t.Fatalf("hide historical external account: %v", err)
	}
	hidden, err := service.Dashboard(fixture.ctx, fixture.membership, query)
	if err != nil {
		t.Fatalf("read statistics after historical deletion: %v", err)
	}
	if hidden.ExternalAccounts == nil || len(hidden.ExternalAccounts.Accounts) != 0 {
		t.Fatalf("historically deleted account leaked into statistics: %#v", hidden.ExternalAccounts)
	}
}

func absMinor(value int64) int64 {
	if value < 0 {
		return -value
	}
	return value
}
