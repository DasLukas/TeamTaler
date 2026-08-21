import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import CalendarCheck from 'lucide-react/dist/esm/icons/calendar-check';
import LockKeyhole from 'lucide-react/dist/esm/icons/lock-keyhole';
import Printer from 'lucide-react/dist/esm/icons/printer';
import X from 'lucide-react/dist/esm/icons/x';
import { useDeferredValue, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { currencyExponent, formatMoney } from '@/api/money';
import type { Period, Settlement } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { StatePanel } from '@/components/ui/StatePanel';
import { DataTable, type DataTableColumnDef, type DataTableDateRange, type DataTableFilterDefinition, type DataTableNumberRange } from '@/features/shared/DataTable';
import tableStyles from '@/features/shared/Table.module.css';
import { useDataTableLabels } from '@/features/shared/useDataTableLabels';
import { useDataTableUrlState } from '@/features/shared/useDataTableUrlState';
import styles from './SettlementsPanel.module.css';

type SettlementFilterId = 'periodId' | 'membershipId' | 'dueAt' | 'amount' | 'status';
const settlementCollator = new Intl.Collator('de-DE', { numeric: true, sensitivity: 'base' });

/** Properties for the settlement workflow and immutable history. */
export interface SettlementsPanelProps {
  settlements: Settlement[];
  settlementsEnabled: boolean;
}

/**
 * Renders the period-close workflow and immutable settlement overview.
 *
 * @param props - Current feature state and immutable settlement history.
 * @returns Localized period controls, settlement table, and close dialog.
 */
export function SettlementsPanel({ settlements, settlementsEnabled }: SettlementsPanelProps) {
  const { t } = useTranslation();
  const { activeGroupId } = useActiveGroup();
  const queryClient = useQueryClient();
  const closePeriodFormId = useId();
  const labels = useDataTableLabels();
  const periodsQuery = useQuery({ queryKey: ['periods', activeGroupId], queryFn: () => api.getPeriods(activeGroupId), enabled: settlementsEnabled });
  const [periodToClose, setPeriodToClose] = useState<Period | null>(null);
  const [label, setLabel] = useState('');
  const [dueAt, setDueAt] = useState('');
  const filterDefinitions = useMemo<readonly DataTableFilterDefinition<SettlementFilterId>[]>(() => [
    {
      allLabel: t('dataTable.allValues'),
      id: 'periodId',
      kind: 'select',
      label: t('periods.period'),
      options: [...new Map(settlements.map((settlement) => [settlement.periodId, { label: settlement.periodLabel, value: settlement.periodId }])).values()],
    },
    {
      allLabel: t('dataTable.allValues'),
      id: 'membershipId',
      kind: 'select',
      label: t('common.member'),
      options: [...new Map(settlements.map((settlement) => [settlement.membershipId, { label: settlement.memberName, value: settlement.membershipId }])).values()],
    },
    { fromLabel: t('dataTable.from'), id: 'dueAt', kind: 'date-range', label: t('periods.due'), toLabel: t('dataTable.to') },
    { id: 'amount', kind: 'number-range', label: t('periods.claim'), maximumLabel: t('dataTable.maximum'), minimumLabel: t('dataTable.minimum'), step: 0.01 },
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
  ], [settlements, t]);
  const tableState = useDataTableUrlState<SettlementFilterId>({
    filterDefinitions,
    initialSorting: [{ id: 'dueAt', desc: true }],
    namespace: 'settlements',
    sortableColumnIds: ['periodLabel', 'memberName', 'dueAt', 'amount', 'paidAmount', 'status'],
  });
  const deferredSearch = useDeferredValue(tableState.searchValue.trim().toLocaleLowerCase('de-DE'));
  const visibleSettlements = useMemo(() => {
    const dueRange = tableState.filters.dueAt as DataTableDateRange | undefined;
    const amountRange = tableState.filters.amount as DataTableNumberRange | undefined;
    const statuses = Array.isArray(tableState.filters.status) ? tableState.filters.status : [];
    const filtered = settlements.filter((settlement) => {
      const amount = Number(settlement.amount.minorUnits) / (10 ** currencyExponent(settlement.amount.currency));
      return (!deferredSearch || `${settlement.periodLabel} ${settlement.memberName} ${settlement.email ?? ''}`.toLocaleLowerCase('de-DE').includes(deferredSearch))
        && (!tableState.filters.periodId || settlement.periodId === tableState.filters.periodId)
        && (!tableState.filters.membershipId || settlement.membershipId === tableState.filters.membershipId)
        && (!dueRange?.from || settlement.dueAt.slice(0, 10) >= dueRange.from)
        && (!dueRange?.to || settlement.dueAt.slice(0, 10) <= dueRange.to)
        && (amountRange?.min === undefined || amount >= amountRange.min)
        && (amountRange?.max === undefined || amount <= amountRange.max)
        && (statuses.length === 0 || statuses.includes(settlement.status));
    });
    const sorting = tableState.sorting[0];
    if (!sorting) return filtered;
    return [...filtered].sort((left, right) => {
      let comparison = 0;
      if (sorting.id === 'periodLabel') comparison = settlementCollator.compare(left.periodLabel, right.periodLabel);
      else if (sorting.id === 'memberName') comparison = settlementCollator.compare(left.memberName, right.memberName);
      else if (sorting.id === 'dueAt') comparison = left.dueAt.localeCompare(right.dueAt);
      else if (sorting.id === 'amount') comparison = BigInt(left.amount.minorUnits) < BigInt(right.amount.minorUnits) ? -1 : BigInt(left.amount.minorUnits) > BigInt(right.amount.minorUnits) ? 1 : 0;
      else if (sorting.id === 'paidAmount') comparison = BigInt(left.paidAmount.minorUnits) < BigInt(right.paidAmount.minorUnits) ? -1 : BigInt(left.paidAmount.minorUnits) > BigInt(right.paidAmount.minorUnits) ? 1 : 0;
      else if (sorting.id === 'status') comparison = settlementCollator.compare(left.status, right.status);
      return sorting.desc ? -comparison : comparison;
    });
  }, [deferredSearch, settlements, tableState.filters, tableState.sorting]);
  const closeMutation = useMutation({
    mutationFn: () => periodToClose ? api.closePeriod(activeGroupId, periodToClose.id, { label: label.trim(), dueAt }) : Promise.reject(new Error(t('periods.noSelection'))),
    onSuccess: async () => {
      setPeriodToClose(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['periods', activeGroupId] }),
        queryClient.invalidateQueries({ queryKey: ['settlements', activeGroupId] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard', activeGroupId] }),
        queryClient.invalidateQueries({ queryKey: ['notifications', activeGroupId] }),
      ]);
    },
  });

  const openPeriod = settlementsEnabled ? periodsQuery.data?.find((period) => period.status === 'OPEN') : undefined;
  const beginClose = (period: Period) => {
    setPeriodToClose(period);
    setLabel(period.label);
    const defaultDue = new Date();
    defaultDue.setDate(defaultDue.getDate() + 14);
    setDueAt(defaultDue.toISOString().slice(0, 10));
  };
  const columns = useMemo<DataTableColumnDef<Settlement>[]>(() => [
    { accessorKey: 'periodLabel', cell: ({ row }) => <strong>{row.original.periodLabel}</strong>, enableSorting: true, header: t('periods.period'), id: 'periodLabel', meta: { label: t('periods.period') } },
    { accessorKey: 'memberName', enableSorting: true, header: t('common.member'), id: 'memberName', meta: { label: t('common.member') } },
    { accessorKey: 'dueAt', cell: ({ row }) => <time dateTime={row.original.dueAt}>{new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(row.original.dueAt))}</time>, enableSorting: true, header: t('periods.due'), id: 'dueAt', meta: { label: t('periods.due') } },
    { accessorFn: (settlement) => settlement.amount.minorUnits, cell: ({ row }) => formatMoney(row.original.amount), enableSorting: true, header: t('periods.claim'), id: 'amount', meta: { align: 'end', label: t('periods.claim') } },
    { accessorFn: (settlement) => settlement.paidAmount.minorUnits, cell: ({ row }) => formatMoney(row.original.paidAmount), enableSorting: true, header: t('periods.paid'), id: 'paidAmount', meta: { align: 'end', label: t('periods.paid') } },
    {
      accessorKey: 'status',
      cell: ({ row }) => <span className={`${tableStyles.status} ${row.original.status === 'PARTIAL' || row.original.status === 'OPEN' ? tableStyles.statusWarning : ''}`}>{row.original.status === 'PAID' ? t('common.paid') : row.original.status === 'PARTIAL' ? t('common.partiallyPaid') : row.original.status === 'CREDIT' ? t('common.credit') : t('common.open')}</span>,
      enableSorting: true,
      header: t('common.status'),
      id: 'status',
      meta: { label: t('common.status') },
    },
    { cell: () => <Button leadingIcon={<Printer size={16} />} onClick={() => window.print()} size="small" variant="ghost">{t('common.print')}</Button>, enableSorting: false, header: () => <span className="sr-only">{t('common.action')}</span>, id: 'action', meta: { label: t('common.action') } },
  ], [t]);

  if (settlementsEnabled && periodsQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (settlementsEnabled && !periodsQuery.data) return <div className={styles.state}><StatePanel kind="error" message={t('periods.error')} /></div>;

  return (
    <div className={styles.content}>
      <header className={styles.header}><div><h2>{t(settlementsEnabled ? 'periods.title' : 'periods.historyTitle')}</h2><p>{t(settlementsEnabled ? 'periods.intro' : 'periods.historyIntro')}</p></div>{openPeriod ? <Button leadingIcon={<LockKeyhole size={18} />} onClick={() => beginClose(openPeriod)}>{t('periods.close')}</Button> : null}</header>
      {openPeriod ? <section className={styles.openPeriod}><span><CalendarCheck size={27} /></span><div><small>{t('periods.current')}</small><strong>{openPeriod.label}</strong><p>{t('periods.openedSince', { date: new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(openPeriod.startsAt)) })}</p></div></section> : null}
      <h3>{t('periods.closedSettlements')}</h3>
      <DataTable
        ariaLabel={t('periods.closedSettlements')}
        columns={columns}
        data={visibleSettlements}
        emptyContent={t('periods.empty')}
        filterDefinitions={filterDefinitions}
        getRowId={(settlement) => settlement.id}
        labels={{ ...labels, searchLabel: t('periods.searchLabel'), searchPlaceholder: t('periods.searchPlaceholder') }}
        minTableWidth="980px"
        {...tableState}
      />
      <Modal onClose={() => setPeriodToClose(null)} open={Boolean(periodToClose)} title={t('periods.closeDialog')}>
        <form className={styles.form} id={closePeriodFormId} onSubmit={(event) => { event.preventDefault(); closeMutation.mutate(); }}>
          <p>{t('periods.closeExplanation')}</p>
          <Field htmlFor="period-label" label={t('periods.label')}><TextInput id="period-label" onChange={(event) => setLabel(event.target.value)} required value={label} /></Field>
          <Field htmlFor="period-due" label={t('periods.paymentDue')}><TextInput id="period-due" onChange={(event) => setDueAt(event.target.value)} required type="date" value={dueAt} /></Field>
          {closeMutation.isError ? <p className={styles.error} role="alert">{closeMutation.error.message}</p> : null}
          <ModalFooter><div className={styles.actions}><Button leadingIcon={<X size={17} />} onClick={() => setPeriodToClose(null)} variant="secondary">{t('common.cancel')}</Button><Button disabled={!label.trim() || !dueAt || closeMutation.isPending} form={closePeriodFormId} leadingIcon={<LockKeyhole size={17} />} type="submit">{t('periods.confirmClose')}</Button></div></ModalFooter>
        </form>
      </Modal>
    </div>
  );
}
