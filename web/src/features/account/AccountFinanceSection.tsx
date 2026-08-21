import { useQuery } from '@tanstack/react-query';
import Download from 'lucide-react/dist/esm/icons/download';
import Printer from 'lucide-react/dist/esm/icons/printer';
import { useDeferredValue, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { currencyExponent, formatMoney, isCreditBalance } from '@/api/money';
import type { LedgerEntry, Settlement } from '@/api/types';
import { canRecordOwnPayment } from '@/app/groupCapabilities';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { StatePanel } from '@/components/ui/StatePanel';
import { SelfPaymentDialog } from '@/features/finance/SelfPaymentDialog';
import { PaymentAttachmentAction } from '@/features/finance/PaymentAttachmentAction';
import { DataTable, type DataTableColumnDef, type DataTableDateRange, type DataTableFilterDefinition, type DataTableNumberRange } from '@/features/shared/DataTable';
import tableStyles from '@/features/shared/Table.module.css';
import { useDataTableLabels } from '@/features/shared/useDataTableLabels';
import { useDataTableUrlState } from '@/features/shared/useDataTableUrlState';
import i18n from '@/i18n';
import { safeCsvCell } from './csv';
import styles from './AccountPage.module.css';

type PersonalSettlementFilterId = 'periodId' | 'dueAt' | 'status';
type LedgerFilterId = 'kind' | 'occurredAt' | 'amount';
const personalFinanceCollator = new Intl.Collator('de-DE', { numeric: true, sensitivity: 'base' });

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
  const labels = useDataTableLabels();
  const ledgerQuery = useQuery({ queryKey: ['ledger', activeGroupId], queryFn: () => api.getLedger(activeGroupId) });
  const dashboardQuery = useQuery({ queryKey: ['dashboard', activeGroupId], queryFn: () => api.getDashboard(activeGroupId) });
  const settlementsQuery = useQuery({ queryKey: ['settlements', activeGroupId], queryFn: () => api.getSettlements(activeGroupId) });
  const transactionSettingsQuery = useQuery({ queryKey: ['transaction-settings', activeGroupId], queryFn: () => api.getTransactionSettings(activeGroupId) });
  const currency = activeGroup.currency || 'EUR';

  const ownSettlements = useMemo(() => (settlementsQuery.data ?? []).filter((settlement) => settlement.membershipId === activeGroup.membership?.id), [activeGroup.membership?.id, settlementsQuery.data]);
  const settlementFilters = useMemo<readonly DataTableFilterDefinition<PersonalSettlementFilterId>[]>(() => [
    {
      allLabel: t('dataTable.allValues'),
      id: 'periodId',
      kind: 'select',
      label: t('account.period'),
      options: [...new Map(ownSettlements.map((settlement) => [settlement.periodId, { label: settlement.periodLabel, value: settlement.periodId }])).values()],
    },
    { fromLabel: t('dataTable.from'), id: 'dueAt', kind: 'date-range', label: t('account.due'), toLabel: t('dataTable.to') },
    {
      id: 'status',
      kind: 'multi-select',
      label: t('common.status'),
      options: [
        { label: t('common.open'), value: 'OPEN' },
        { label: t('common.partiallyPaid'), value: 'PARTIAL' },
        { label: t('common.paid'), value: 'PAID' },
        { label: t('common.credit'), value: 'CREDIT' },
      ],
    },
  ], [ownSettlements, t]);
  const settlementTableState = useDataTableUrlState<PersonalSettlementFilterId>({
    filterDefinitions: settlementFilters,
    initialSorting: [{ id: 'dueAt', desc: true }],
    namespace: 'personal-settlements',
    sortableColumnIds: ['periodLabel', 'dueAt', 'amount', 'paidAmount', 'openAmount', 'status'],
  });
  const deferredSettlementSearch = useDeferredValue(settlementTableState.searchValue.trim().toLocaleLowerCase('de-DE'));
  const visibleSettlements = useMemo(() => {
    const dueRange = settlementTableState.filters.dueAt as DataTableDateRange | undefined;
    const statuses = Array.isArray(settlementTableState.filters.status) ? settlementTableState.filters.status : [];
    const filtered = ownSettlements.filter((settlement) => (!deferredSettlementSearch || settlement.periodLabel.toLocaleLowerCase('de-DE').includes(deferredSettlementSearch))
      && (!settlementTableState.filters.periodId || settlement.periodId === settlementTableState.filters.periodId)
      && (!dueRange?.from || settlement.dueAt.slice(0, 10) >= dueRange.from)
      && (!dueRange?.to || settlement.dueAt.slice(0, 10) <= dueRange.to)
      && (statuses.length === 0 || statuses.includes(settlement.status)));
    const sorting = settlementTableState.sorting[0];
    if (!sorting) return filtered;
    return [...filtered].sort((left, right) => {
      let comparison = 0;
      if (sorting.id === 'periodLabel') comparison = personalFinanceCollator.compare(left.periodLabel, right.periodLabel);
      else if (sorting.id === 'dueAt') comparison = left.dueAt.localeCompare(right.dueAt);
      else if (sorting.id === 'amount') comparison = BigInt(left.amount.minorUnits) < BigInt(right.amount.minorUnits) ? -1 : BigInt(left.amount.minorUnits) > BigInt(right.amount.minorUnits) ? 1 : 0;
      else if (sorting.id === 'paidAmount') comparison = BigInt(left.paidAmount.minorUnits) < BigInt(right.paidAmount.minorUnits) ? -1 : BigInt(left.paidAmount.minorUnits) > BigInt(right.paidAmount.minorUnits) ? 1 : 0;
      else if (sorting.id === 'openAmount') {
        const leftOpen = BigInt(left.openAmount?.minorUnits ?? left.amount.minorUnits) - (left.openAmount ? 0n : BigInt(left.paidAmount.minorUnits));
        const rightOpen = BigInt(right.openAmount?.minorUnits ?? right.amount.minorUnits) - (right.openAmount ? 0n : BigInt(right.paidAmount.minorUnits));
        comparison = leftOpen < rightOpen ? -1 : leftOpen > rightOpen ? 1 : 0;
      } else if (sorting.id === 'status') comparison = personalFinanceCollator.compare(left.status, right.status);
      return sorting.desc ? -comparison : comparison;
    });
  }, [deferredSettlementSearch, ownSettlements, settlementTableState.filters, settlementTableState.sorting]);
  const ledgerFilters = useMemo<readonly DataTableFilterDefinition<LedgerFilterId>[]>(() => [
    {
      allLabel: t('dataTable.allValues'),
      dropdown: true,
      emptyLabel: t('dataTable.noOptions'),
      id: 'kind',
      kind: 'multi-select',
      label: t('account.transaction'),
      options: [
        { label: t('account.kind.booking'), value: 'BOOKING' },
        { label: t('account.kind.payment'), value: 'PAYMENT' },
        { label: t('account.kind.reversal'), value: 'REVERSAL' },
        { label: t('account.kind.credit'), value: 'CREDIT' },
      ],
    },
    { fromLabel: t('dataTable.from'), id: 'occurredAt', kind: 'date-range', label: t('common.date'), toLabel: t('dataTable.to') },
    { id: 'amount', kind: 'number-range', label: `${t('common.amount')} (${currency})`, maximumLabel: t('dataTable.maximum'), minimumLabel: t('dataTable.minimum'), step: 0.01 },
  ], [currency, t]);
  const ledgerTableState = useDataTableUrlState<LedgerFilterId>({
    filterDefinitions: ledgerFilters,
    initialSorting: [{ id: 'occurredAt', desc: true }],
    namespace: 'personal-ledger',
    sortableColumnIds: ['occurredAt', 'kind', 'description', 'amount', 'balance'],
  });
  const deferredLedgerSearch = useDeferredValue(ledgerTableState.searchValue.trim().toLocaleLowerCase('de-DE'));
  const visibleLedger = useMemo(() => {
    const dateRange = ledgerTableState.filters.occurredAt as DataTableDateRange | undefined;
    const amountRange = ledgerTableState.filters.amount as DataTableNumberRange | undefined;
    const kinds = Array.isArray(ledgerTableState.filters.kind) ? ledgerTableState.filters.kind : [];
    const factor = 10 ** currencyExponent(currency);
    const filtered = (ledgerQuery.data ?? []).filter((entry) => {
      const amount = Number(entry.amount.minorUnits) / factor;
      return (!deferredLedgerSearch || entry.description.toLocaleLowerCase('de-DE').includes(deferredLedgerSearch))
        && (kinds.length === 0 || kinds.includes(entry.kind))
        && (!dateRange?.from || entry.occurredAt.slice(0, 10) >= dateRange.from)
        && (!dateRange?.to || entry.occurredAt.slice(0, 10) <= dateRange.to)
        && (amountRange?.min === undefined || amount >= amountRange.min)
        && (amountRange?.max === undefined || amount <= amountRange.max);
    });
    const sorting = ledgerTableState.sorting[0];
    if (!sorting) return filtered;
    return [...filtered].sort((left, right) => {
      let comparison = 0;
      if (sorting.id === 'occurredAt') comparison = left.occurredAt.localeCompare(right.occurredAt);
      else if (sorting.id === 'kind') comparison = personalFinanceCollator.compare(left.kind, right.kind);
      else if (sorting.id === 'description') comparison = personalFinanceCollator.compare(left.description, right.description);
      else if (sorting.id === 'amount') comparison = BigInt(left.amount.minorUnits) < BigInt(right.amount.minorUnits) ? -1 : BigInt(left.amount.minorUnits) > BigInt(right.amount.minorUnits) ? 1 : 0;
      else if (sorting.id === 'balance') comparison = BigInt(left.balance.minorUnits) < BigInt(right.balance.minorUnits) ? -1 : BigInt(left.balance.minorUnits) > BigInt(right.balance.minorUnits) ? 1 : 0;
      return sorting.desc ? -comparison : comparison;
    });
  }, [currency, deferredLedgerSearch, ledgerQuery.data, ledgerTableState.filters, ledgerTableState.sorting]);
  const settlementColumns = useMemo<DataTableColumnDef<Settlement>[]>(() => [
    { accessorKey: 'periodLabel', cell: ({ row }) => <strong>{row.original.periodLabel}</strong>, enableSorting: true, header: t('account.period'), id: 'periodLabel', meta: { label: t('account.period') } },
    { accessorKey: 'dueAt', cell: ({ row }) => row.original.dueAt ? <time dateTime={row.original.dueAt}>{new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(row.original.dueAt))}</time> : '–', enableSorting: true, header: t('account.due'), id: 'dueAt', meta: { label: t('account.due') } },
    { accessorFn: (settlement) => settlement.amount.minorUnits, cell: ({ row }) => formatMoney(row.original.amount), enableSorting: true, header: t('account.claim'), id: 'amount', meta: { align: 'end', label: t('account.claim') } },
    { accessorFn: (settlement) => settlement.paidAmount.minorUnits, cell: ({ row }) => formatMoney(row.original.paidAmount), enableSorting: true, header: t('account.paid'), id: 'paidAmount', meta: { align: 'end', label: t('account.paid') } },
    { accessorFn: (settlement) => settlement.openAmount?.minorUnits, cell: ({ row }) => <strong>{formatMoney(row.original.openAmount ?? { minorUnits: (BigInt(row.original.amount.minorUnits) - BigInt(row.original.paidAmount.minorUnits)).toString(), currency: row.original.amount.currency })}</strong>, enableSorting: true, header: t('account.open'), id: 'openAmount', meta: { align: 'end', label: t('account.open') } },
    { accessorKey: 'status', cell: ({ row }) => <span className={`${tableStyles.status} ${row.original.status === 'OPEN' || row.original.status === 'PARTIAL' ? tableStyles.statusWarning : ''}`}>{row.original.status === 'PAID' ? t('common.paid') : row.original.status === 'PARTIAL' ? t('common.partiallyPaid') : row.original.status === 'CREDIT' ? t('common.credit') : t('common.open')}</span>, enableSorting: true, header: t('common.status'), id: 'status', meta: { label: t('common.status') } },
    { cell: () => <Button leadingIcon={<Printer size={16} />} onClick={() => window.print()} size="small" variant="ghost">{t('account.printPdf')}</Button>, enableSorting: false, header: () => <span className="sr-only">{t('common.action')}</span>, id: 'action', meta: { label: t('common.action') } },
  ], [t]);
  const ledgerColumns = useMemo<DataTableColumnDef<LedgerEntry>[]>(() => [
    { accessorKey: 'occurredAt', cell: ({ row }) => <time dateTime={row.original.occurredAt}>{new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(row.original.occurredAt))}</time>, enableSorting: true, header: t('common.date'), id: 'occurredAt', meta: { label: t('common.date') } },
    { accessorKey: 'kind', cell: ({ row }) => row.original.kind === 'BOOKING' ? t('account.kind.booking') : row.original.kind === 'PAYMENT' ? t('account.kind.payment') : row.original.kind === 'REVERSAL' ? t('account.kind.reversal') : t('account.kind.credit'), enableSorting: true, header: t('account.transaction'), id: 'kind', meta: { label: t('account.transaction') } },
    { accessorKey: 'description', enableSorting: true, header: t('common.description'), id: 'description', meta: { label: t('common.description') } },
    { accessorFn: (entry) => entry.amount.minorUnits, cell: ({ row }) => formatMoney(row.original.amount), enableSorting: true, header: t('common.amount'), id: 'amount', meta: { align: 'end', label: t('common.amount') } },
    { accessorFn: (entry) => entry.balance.minorUnits, cell: ({ row }) => <strong>{formatMoney(row.original.balance)}</strong>, enableSorting: true, header: t('account.balance'), id: 'balance', meta: { align: 'end', label: t('account.balance') } },
    { cell: ({ row }) => row.original.attachment ? <PaymentAttachmentAction attachment={row.original.attachment} groupId={activeGroupId} paymentId={row.original.referenceId} /> : null, enableSorting: false, header: () => <span className="sr-only">{t('paymentAttachment.action', { defaultValue: 'Receipt' })}</span>, id: 'attachment', meta: { label: t('paymentAttachment.action', { defaultValue: 'Receipt' }) } },
  ], [activeGroupId, t]);

  if (ledgerQuery.isLoading || dashboardQuery.isLoading || settlementsQuery.isLoading || transactionSettingsQuery.isLoading) return <StatePanel kind="loading" />;
  if (ledgerQuery.isError || dashboardQuery.isError || settlementsQuery.isError || transactionSettingsQuery.isError || !ledgerQuery.data || !dashboardQuery.data || !settlementsQuery.data || !transactionSettingsQuery.data) return <StatePanel kind="error" message={t('account.error')} />;

  const balance = dashboardQuery.data.openBalance;
  const hasCreditBalance = isCreditBalance(balance);
  const canRecordPayment = canRecordOwnPayment(activeGroup.membership?.effectiveGrants);
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
        <DataTable ariaLabel={t('account.closedSettlements')} columns={settlementColumns} data={visibleSettlements} emptyContent={t('account.noSettlements')} filterDefinitions={settlementFilters} getRowId={(settlement) => settlement.id} labels={{ ...labels, searchLabel: t('account.settlementSearchLabel'), searchPlaceholder: t('account.settlementSearchPlaceholder') }} minTableWidth="980px" {...settlementTableState} />
      </section> : null}
      <h2>{t('account.movements')}</h2>
      <DataTable ariaLabel={t('account.movements')} columns={ledgerColumns} data={visibleLedger} emptyContent={t('account.noMovements')} filterDefinitions={ledgerFilters} getRowId={(entry) => entry.id} labels={{ ...labels, searchLabel: t('account.ledgerSearchLabel'), searchPlaceholder: t('account.ledgerSearchPlaceholder') }} minTableWidth="860px" {...ledgerTableState} />
    </section>
  );
}
