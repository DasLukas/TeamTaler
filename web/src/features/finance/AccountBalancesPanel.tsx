import { useQuery } from '@tanstack/react-query';
import Archive from 'lucide-react/dist/esm/icons/archive';
import CircleCheck from 'lucide-react/dist/esm/icons/circle-check';
import CircleDollarSign from 'lucide-react/dist/esm/icons/circle-dollar-sign';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import WalletCards from 'lucide-react/dist/esm/icons/wallet-cards';
import { useDeferredValue, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { currencyExponent, formatMoney } from '@/api/money';
import type { AccountSummary } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Avatar } from '@/components/ui/Avatar';
import { StatePanel } from '@/components/ui/StatePanel';
import { DataTable, type DataTableColumnDef, type DataTableFilterDefinition, type DataTableNumberRange } from '@/features/shared/DataTable';
import { createMemberFilterOption } from '@/features/shared/memberFilterOption';
import { useDataTableLabels } from '@/features/shared/useDataTableLabels';
import { useDataTableUrlState } from '@/features/shared/useDataTableUrlState';
import { deriveAccountOverview } from './accountOverview';
import { MembershipStatusBadge } from './MembershipStatusBadge';
import styles from './AccountBalancesPanel.module.css';

function balanceState(account: AccountSummary): 'due' | 'settled' | 'credit' {
  const balance = BigInt(account.balance.minorUnits);
  if (balance > 0n) return 'due';
  if (balance < 0n) return 'credit';
  return 'settled';
}

type AccountFilterId = 'membershipId' | 'membershipStatus' | 'balanceState' | 'amount';
const accountCollator = new Intl.Collator('de-DE', { numeric: true, sensitivity: 'base' });

/**
 * Renders consolidated balances grouped by operational and deleted lifecycle state.
 *
 * @returns Summary cards, search, and responsive account collections.
 */
export function AccountBalancesPanel() {
  const { t } = useTranslation();
  const { activeGroupId, activeGroup } = useActiveGroup();
  const labels = useDataTableLabels();
  const accountsQuery = useQuery({ queryKey: ['account-summaries', activeGroupId], queryFn: () => api.getAccountSummaries(activeGroupId) });
  const filterDefinitions = useMemo<readonly DataTableFilterDefinition<AccountFilterId>[]>(() => [
    {
      allLabel: t('dataTable.allValues'),
      id: 'membershipId',
      kind: 'select',
      label: t('common.member'),
      options: (accountsQuery.data ?? []).map(createMemberFilterOption),
    },
    {
      allLabel: t('dataTable.allValues'),
      dropdown: true,
      emptyLabel: t('dataTable.noOptions'),
      id: 'membershipStatus',
      kind: 'multi-select',
      label: t('financeWorkspace.membershipStatus'),
      options: [
        { label: t('financeWorkspace.active'), value: 'ACTIVE', visual: <CircleCheck size={19} /> },
        { label: t('financeWorkspace.archived'), value: 'ARCHIVED', visual: <Archive size={19} /> },
        { label: t('common.deleted'), value: 'DELETED', visual: <Trash2 size={19} /> },
      ],
    },
    {
      allLabel: t('dataTable.allValues'),
      dropdown: true,
      emptyLabel: t('dataTable.noOptions'),
      id: 'balanceState',
      kind: 'multi-select',
      label: t('financeWorkspace.balanceState'),
      options: [
        { label: t('financeWorkspace.states.due'), value: 'due', visual: <CircleDollarSign size={19} /> },
        { label: t('financeWorkspace.states.settled'), value: 'settled', visual: <CircleCheck size={19} /> },
        { label: t('financeWorkspace.states.credit'), value: 'credit', visual: <WalletCards size={19} /> },
      ],
    },
    { id: 'amount', kind: 'number-range', label: `${t('financeWorkspace.balance')} (${activeGroup.currency})`, maximumLabel: t('dataTable.maximum'), minimumLabel: t('dataTable.minimum'), step: 0.01 },
  ], [accountsQuery.data, activeGroup.currency, t]);
  const tableState = useDataTableUrlState<AccountFilterId>({
    filterDefinitions,
    initialSorting: [{ id: 'memberName', desc: false }],
    namespace: 'account-balances',
    sortableColumnIds: ['memberName', 'membershipStatus', 'balanceState', 'amount'],
  });
  const deferredSearch = useDeferredValue(tableState.searchValue.trim().toLocaleLowerCase('de-DE'));
  const totals = useMemo(() => deriveAccountOverview(accountsQuery.data ?? [], activeGroup.currency), [accountsQuery.data, activeGroup.currency]);
  const visibleAccounts = useMemo(() => {
    const statuses = Array.isArray(tableState.filters.membershipStatus) ? tableState.filters.membershipStatus : [];
    const states = Array.isArray(tableState.filters.balanceState) ? tableState.filters.balanceState : [];
    const amountRange = tableState.filters.amount as DataTableNumberRange | undefined;
    const factor = BigInt(10 ** currencyExponent(activeGroup.currency));
    const minimum = amountRange?.min === undefined ? undefined : BigInt(Math.round(amountRange.min * Number(factor)));
    const maximum = amountRange?.max === undefined ? undefined : BigInt(Math.round(amountRange.max * Number(factor)));
    const filtered = (accountsQuery.data ?? []).filter((account) => {
      const amount = BigInt(account.balance.minorUnits);
      return (!deferredSearch || account.displayName.toLocaleLowerCase('de-DE').includes(deferredSearch))
        && (!tableState.filters.membershipId || account.membershipId === tableState.filters.membershipId)
        && (statuses.length === 0 || statuses.includes(account.status))
        && (states.length === 0 || states.includes(balanceState(account)))
        && (minimum === undefined || amount >= minimum)
        && (maximum === undefined || amount <= maximum);
    });
    const sorting = tableState.sorting[0];
    if (!sorting) return filtered;
    return [...filtered].sort((left, right) => {
      let comparison = 0;
      if (sorting.id === 'memberName') comparison = accountCollator.compare(left.displayName, right.displayName);
      else if (sorting.id === 'membershipStatus') comparison = accountCollator.compare(left.status, right.status);
      else if (sorting.id === 'balanceState') comparison = accountCollator.compare(balanceState(left), balanceState(right));
      else if (sorting.id === 'amount') comparison = BigInt(left.balance.minorUnits) < BigInt(right.balance.minorUnits) ? -1 : BigInt(left.balance.minorUnits) > BigInt(right.balance.minorUnits) ? 1 : 0;
      return sorting.desc ? -comparison : comparison;
    });
  }, [accountsQuery.data, activeGroup.currency, deferredSearch, tableState.filters, tableState.sorting]);
  const exportQuery = useMemo(() => {
    const amountRange = tableState.filters.amount as DataTableNumberRange | undefined;
    const sorting = tableState.sorting[0];
    const toMinorUnits = (value: number | undefined) => value === undefined ? undefined : Math.round(value * (10 ** currencyExponent(activeGroup.currency))).toString();
    return {
      amountMax: toMinorUnits(amountRange?.max),
      amountMin: toMinorUnits(amountRange?.min),
      balanceState: Array.isArray(tableState.filters.balanceState) ? tableState.filters.balanceState : undefined,
      direction: sorting?.desc ? 'desc' : 'asc',
      membershipId: tableState.filters.membershipId as string | undefined,
      membershipStatus: Array.isArray(tableState.filters.membershipStatus) ? tableState.filters.membershipStatus : undefined,
      q: deferredSearch || undefined,
      sort: sorting?.id ?? 'memberName',
    };
  }, [activeGroup.currency, deferredSearch, tableState.filters, tableState.sorting]);
  const columns = useMemo<DataTableColumnDef<AccountSummary>[]>(() => [
    {
      accessorKey: 'displayName',
      cell: ({ row }) => <span className={styles.member}><Avatar name={row.original.displayName} size="small" src={row.original.avatarUrl} /><strong>{row.original.displayName}</strong></span>,
      enableSorting: true,
      header: t('common.member'),
      id: 'memberName',
      meta: { label: t('common.member') },
    },
    { accessorKey: 'status', cell: ({ row }) => <MembershipStatusBadge status={row.original.status} />, enableSorting: true, header: t('financeWorkspace.membershipStatus'), id: 'membershipStatus', meta: { label: t('financeWorkspace.membershipStatus') } },
    {
      accessorFn: balanceState,
      cell: ({ row }) => { const state = balanceState(row.original); return <span className={`${styles.state} ${styles[state]}`}>{t(`financeWorkspace.states.${state}`)}</span>; },
      enableSorting: true,
      header: t('financeWorkspace.balanceState'),
      id: 'balanceState',
      meta: { label: t('financeWorkspace.balanceState') },
    },
    { accessorFn: (account) => account.balance.minorUnits, cell: ({ row }) => <strong>{formatMoney(row.original.balance)}</strong>, enableSorting: true, header: t('financeWorkspace.balance'), id: 'amount', meta: { align: 'end', label: t('financeWorkspace.balance') } },
  ], [t]);

  if (accountsQuery.isLoading) return <div className={styles.queryState}><StatePanel kind="loading" /></div>;
  if (!accountsQuery.data) return <div className={styles.queryState}><StatePanel kind="error" message={t('financeWorkspace.overviewError')} /></div>;

  return (
    <div className={styles.content}>
      <header className={styles.header}><h2>{t('financeWorkspace.overviewTitle')}</h2><p>{t('financeWorkspace.overviewIntro')}</p></header>
      <div className={styles.summaries}>
        <article><span>{t('financeWorkspace.receivables')}</span><strong>{formatMoney(totals.receivables)}</strong></article>
        <article><span>{t('financeWorkspace.credits')}</span><strong>{formatMoney(totals.credits)}</strong></article>
        <article><span>{t('financeWorkspace.netBalance')}</span><strong>{formatMoney(totals.net)}</strong></article>
      </div>
      <DataTable
        ariaLabel={t('financeWorkspace.overviewTitle')}
        columns={columns}
        data={visibleAccounts}
        emptyContent={tableState.searchValue || Object.keys(tableState.filters).length > 0 ? t('financeWorkspace.noSearchResults') : t('financeWorkspace.noAccounts')}
        exportConfig={{ disabled: deferredSearch !== tableState.searchValue.trim().toLocaleLowerCase('de-DE'), groupId: activeGroupId, query: exportQuery, table: 'ACCOUNT_BALANCES', title: t('financeWorkspace.overviewTitle') }}
        filterDefinitions={filterDefinitions}
        getRowId={(account) => account.membershipId}
        labels={{ ...labels, searchLabel: t('financeWorkspace.search'), searchPlaceholder: t('financeWorkspace.searchPlaceholder') }}
        minTableWidth="720px"
        {...tableState}
      />
    </div>
  );
}
