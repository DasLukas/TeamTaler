import { useQuery } from '@tanstack/react-query';
import Printer from 'lucide-react/dist/esm/icons/printer';
import { useDeferredValue, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney, isCreditBalance } from '@/api/money';
import type { Settlement } from '@/api/types';
import { canRecordOwnPayment } from '@/app/groupCapabilities';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { StatePanel } from '@/components/ui/StatePanel';
import { SelfPaymentDialog } from '@/features/finance/SelfPaymentDialog';
import { DataTable, type DataTableColumnDef, type DataTableDateRange, type DataTableFilterDefinition } from '@/features/shared/DataTable';
import { formatGermanDate } from '@/features/shared/dateFormat';
import tableStyles from '@/features/shared/Table.module.css';
import { useDataTableLabels } from '@/features/shared/useDataTableLabels';
import { useDataTableUrlState } from '@/features/shared/useDataTableUrlState';
import styles from './AccountPage.module.css';

type PersonalSettlementFilterId = 'periodId' | 'dueAt' | 'status';
const personalFinanceCollator = new Intl.Collator('de-DE', { numeric: true, sensitivity: 'base' });

/**
 * Loads and renders personal financial data independently from account settings.
 *
 * @returns Personal balance, settlements, and export controls.
 */
export function AccountFinanceSection() {
  const { t } = useTranslation();
  const { activeGroupId, activeGroup } = useActiveGroup();
  const labels = useDataTableLabels();
  const dashboardQuery = useQuery({ queryKey: ['dashboard', activeGroupId], queryFn: () => api.getDashboard(activeGroupId) });
  const settlementsQuery = useQuery({ queryKey: ['settlements', activeGroupId], queryFn: () => api.getSettlements(activeGroupId) });
  const transactionSettingsQuery = useQuery({ queryKey: ['transaction-settings', activeGroupId], queryFn: () => api.getTransactionSettings(activeGroupId) });

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
  const settlementExportQuery = useMemo(() => {
    const dueRange = settlementTableState.filters.dueAt as DataTableDateRange | undefined;
    const sorting = settlementTableState.sorting[0];
    return {
      direction: sorting?.desc ? 'desc' : 'asc',
      dueFrom: dueRange?.from,
      dueTo: dueRange?.to,
      periodId: settlementTableState.filters.periodId as string | undefined,
      q: deferredSettlementSearch || undefined,
      sort: sorting?.id ?? 'dueAt',
      status: Array.isArray(settlementTableState.filters.status) ? settlementTableState.filters.status : undefined,
    };
  }, [deferredSettlementSearch, settlementTableState.filters, settlementTableState.sorting]);
  const settlementColumns = useMemo<DataTableColumnDef<Settlement>[]>(() => [
    { accessorKey: 'periodLabel', cell: ({ row }) => <strong>{row.original.periodLabel}</strong>, enableSorting: true, header: t('account.period'), id: 'periodLabel', meta: { label: t('account.period') } },
    { accessorKey: 'dueAt', cell: ({ row }) => row.original.dueAt ? <time dateTime={row.original.dueAt}>{formatGermanDate(row.original.dueAt)}</time> : '–', enableSorting: true, header: t('account.due'), id: 'dueAt', meta: { label: t('account.due') } },
    { accessorFn: (settlement) => settlement.amount.minorUnits, cell: ({ row }) => formatMoney(row.original.amount), enableSorting: true, header: t('account.claim'), id: 'amount', meta: { align: 'end', label: t('account.claim') } },
    { accessorFn: (settlement) => settlement.paidAmount.minorUnits, cell: ({ row }) => formatMoney(row.original.paidAmount), enableSorting: true, header: t('account.paid'), id: 'paidAmount', meta: { align: 'end', label: t('account.paid') } },
    { accessorFn: (settlement) => settlement.openAmount?.minorUnits, cell: ({ row }) => <strong>{formatMoney(row.original.openAmount ?? { minorUnits: (BigInt(row.original.amount.minorUnits) - BigInt(row.original.paidAmount.minorUnits)).toString(), currency: row.original.amount.currency })}</strong>, enableSorting: true, header: t('account.open'), id: 'openAmount', meta: { align: 'end', label: t('account.open') } },
    { accessorKey: 'status', cell: ({ row }) => <span className={`${tableStyles.status} ${row.original.status === 'OPEN' || row.original.status === 'PARTIAL' ? tableStyles.statusWarning : ''}`}>{row.original.status === 'PAID' ? t('common.paid') : row.original.status === 'PARTIAL' ? t('common.partiallyPaid') : row.original.status === 'CREDIT' ? t('common.credit') : t('common.open')}</span>, enableSorting: true, header: t('common.status'), id: 'status', meta: { label: t('common.status') } },
    { cell: () => <Button leadingIcon={<Printer size={16} />} onClick={() => window.print()} size="small" variant="ghost">{t('account.printPdf')}</Button>, enableSorting: false, header: () => <span className="sr-only">{t('common.action')}</span>, id: 'action', meta: { label: t('common.action') } },
  ], [t]);
  if (dashboardQuery.isLoading || settlementsQuery.isLoading || transactionSettingsQuery.isLoading) return <StatePanel kind="loading" />;
  if (dashboardQuery.isError || settlementsQuery.isError || transactionSettingsQuery.isError || !dashboardQuery.data || !settlementsQuery.data || !transactionSettingsQuery.data) return <StatePanel kind="error" message={t('account.error')} />;

  const balance = dashboardQuery.data.openBalance;
  const hasCreditBalance = isCreditBalance(balance);
  const canRecordPayment = canRecordOwnPayment(activeGroup.membership?.effectiveGrants);
  const settlementsEnabled = transactionSettingsQuery.data.settlementsEnabled;
  const showSettlements = settlementsEnabled || ownSettlements.length > 0;
  return (
    <section aria-label={t('account.financeTitle')} className={styles.finance}>
      <section className={styles.balance}>
        <div className={styles.balanceValue}><span>{t('account.currentOpenAmount')}</span><strong className={hasCreditBalance ? styles.creditBalance : undefined} data-financial-state={hasCreditBalance ? 'credit' : 'due'}>{formatMoney(balance)}</strong></div>
        {canRecordPayment ? <SelfPaymentDialog className={styles.paymentAction} openBalance={balance} /> : null}
      </section>
      {showSettlements ? <section className={styles.settlements}>
        <h2>{t(settlementsEnabled ? 'account.closedSettlements' : 'account.settlementHistory')}</h2>
        <DataTable ariaLabel={t('account.closedSettlements')} columns={settlementColumns} data={visibleSettlements} emptyContent={t('account.noSettlements')} exportConfig={{ disabled: deferredSettlementSearch !== settlementTableState.searchValue.trim().toLocaleLowerCase('de-DE'), groupId: activeGroupId, query: settlementExportQuery, table: 'PERSONAL_SETTLEMENTS', title: t('account.closedSettlements') }} filterDefinitions={settlementFilters} getRowId={(settlement) => settlement.id} labels={{ ...labels, searchLabel: t('account.settlementSearchLabel'), searchPlaceholder: t('account.settlementSearchPlaceholder') }} minTableWidth="980px" {...settlementTableState} />
      </section> : null}
    </section>
  );
}
