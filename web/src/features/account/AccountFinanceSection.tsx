import { useQuery } from '@tanstack/react-query';
import Download from 'lucide-react/dist/esm/icons/download';
import Printer from 'lucide-react/dist/esm/icons/printer';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney, isCreditBalance } from '@/api/money';
import type { LedgerEntry } from '@/api/types';
import { canRecordOwnPayment } from '@/app/groupCapabilities';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { StatePanel } from '@/components/ui/StatePanel';
import { SelfPaymentDialog } from '@/features/finance/SelfPaymentDialog';
import tableStyles from '@/features/shared/Table.module.css';
import i18n from '@/i18n';
import { safeCsvCell } from './csv';
import styles from './AccountPage.module.css';

function downloadLedger(entries: LedgerEntry[]): void {
  const rows = [[i18n.t('account.csv.date'), i18n.t('account.csv.kind'), i18n.t('account.csv.description'), i18n.t('account.csv.amount'), i18n.t('account.csv.balance')], ...entries.map((entry) => [entry.occurredAt, entry.kind, entry.description, entry.amount.minorUnits, entry.balance.minorUnits])];
  const csv = rows.map((row) => row.map(safeCsvCell).join(';')).join('\n');
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = i18n.t('account.csvFileName');
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Loads and renders personal financial data independently from account settings.
 *
 * @returns Personal balance, settlements, ledger, and export controls.
 */
export function AccountFinanceSection() {
  const { t } = useTranslation();
  const { activeGroupId, activeGroup } = useActiveGroup();
  const ledgerQuery = useQuery({ queryKey: ['ledger', activeGroupId], queryFn: () => api.getLedger(activeGroupId) });
  const dashboardQuery = useQuery({ queryKey: ['dashboard', activeGroupId], queryFn: () => api.getDashboard(activeGroupId) });
  const settlementsQuery = useQuery({ queryKey: ['settlements', activeGroupId], queryFn: () => api.getSettlements(activeGroupId) });
  const transactionSettingsQuery = useQuery({ queryKey: ['transaction-settings', activeGroupId], queryFn: () => api.getTransactionSettings(activeGroupId) });

  if (ledgerQuery.isLoading || dashboardQuery.isLoading || settlementsQuery.isLoading || transactionSettingsQuery.isLoading) return <StatePanel kind="loading" />;
  if (ledgerQuery.isError || dashboardQuery.isError || settlementsQuery.isError || transactionSettingsQuery.isError || !ledgerQuery.data || !dashboardQuery.data || !settlementsQuery.data || !transactionSettingsQuery.data) return <StatePanel kind="error" message={t('account.error')} />;

  const balance = dashboardQuery.data.openBalance;
  const hasCreditBalance = isCreditBalance(balance);
  const canRecordPayment = canRecordOwnPayment(activeGroup.membership?.effectiveGrants);
  const ownSettlements = settlementsQuery.data.filter((settlement) => settlement.membershipId === activeGroup.membership?.id);
  const settlementsEnabled = transactionSettingsQuery.data.settlementsEnabled;
  const showSettlements = settlementsEnabled || ownSettlements.length > 0;
  return (
    <section aria-label={t('account.financeTitle')} className={styles.finance}>
      <div className={styles.financeActions}>
        <Button leadingIcon={<Download size={18} />} onClick={() => downloadLedger(ledgerQuery.data)} variant="secondary">{t('account.csvExport')}</Button>
        <Button leadingIcon={<Printer size={18} />} onClick={() => window.print()}>{t('common.print')}</Button>
      </div>
      <section className={styles.balance}>
        <div className={styles.balanceValue}><span>{t('account.currentOpenAmount')}</span><strong className={hasCreditBalance ? styles.creditBalance : undefined} data-financial-state={hasCreditBalance ? 'credit' : 'due'}>{formatMoney(balance)}</strong></div>
        {canRecordPayment ? <SelfPaymentDialog className={styles.paymentAction} openBalance={balance} /> : null}
      </section>
      {showSettlements ? <section className={styles.settlements}>
        <h2>{t(settlementsEnabled ? 'account.closedSettlements' : 'account.settlementHistory')}</h2>
        {ownSettlements.length === 0 ? <StatePanel kind="empty" message={t('account.noSettlements')} /> : (
          <div className={tableStyles.tableWrap}><table className={tableStyles.table}><thead><tr><th>{t('account.period')}</th><th>{t('account.due')}</th><th className={tableStyles.number}>{t('account.claim')}</th><th className={tableStyles.number}>{t('account.paid')}</th><th className={tableStyles.number}>{t('account.open')}</th><th>{t('common.status')}</th><th><span className="sr-only">{t('common.action')}</span></th></tr></thead><tbody>{ownSettlements.map((settlement) => <tr key={settlement.id}><td><strong>{settlement.periodLabel}</strong></td><td>{settlement.dueAt ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(settlement.dueAt)) : '–'}</td><td className={tableStyles.number}>{formatMoney(settlement.amount)}</td><td className={tableStyles.number}>{formatMoney(settlement.paidAmount)}</td><td className={tableStyles.number}><strong>{formatMoney(settlement.openAmount ?? { minorUnits: (BigInt(settlement.amount.minorUnits) - BigInt(settlement.paidAmount.minorUnits)).toString(), currency: settlement.amount.currency })}</strong></td><td><span className={`${tableStyles.status} ${settlement.status === 'OPEN' || settlement.status === 'PARTIAL' ? tableStyles.statusWarning : ''}`}>{settlement.status === 'PAID' ? t('common.paid') : settlement.status === 'PARTIAL' ? t('common.partiallyPaid') : settlement.status === 'CREDIT' ? t('common.credit') : t('common.open')}</span></td><td><Button leadingIcon={<Printer size={16} />} onClick={() => window.print()} size="small" variant="ghost">{t('account.printPdf')}</Button></td></tr>)}</tbody></table></div>
        )}
      </section> : null}
      <h2>{t('account.movements')}</h2>
      {ledgerQuery.data.length === 0 ? <StatePanel kind="empty" message={t('account.noMovements')} /> : (
        <div className={tableStyles.tableWrap}>
          <table className={tableStyles.table}>
            <thead><tr><th>{t('common.date')}</th><th>{t('account.transaction')}</th><th>{t('common.description')}</th><th className={tableStyles.number}>{t('common.amount')}</th><th className={tableStyles.number}>{t('account.balance')}</th></tr></thead>
            <tbody>{ledgerQuery.data.map((entry) => <tr key={entry.id}><td>{new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(entry.occurredAt))}</td><td>{entry.kind === 'BOOKING' ? t('account.kind.booking') : entry.kind === 'PAYMENT' ? t('account.kind.payment') : entry.kind === 'REVERSAL' ? t('account.kind.reversal') : t('account.kind.credit')}</td><td>{entry.description}</td><td className={tableStyles.number}>{formatMoney(entry.amount)}</td><td className={tableStyles.number}><strong>{formatMoney(entry.balance)}</strong></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
