import { useQuery } from '@tanstack/react-query';
import { useDeferredValue, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { currencyExponent, formatMoney } from '@/api/money';
import type { AccountSummary } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Avatar } from '@/components/ui/Avatar';
import { StatePanel } from '@/components/ui/StatePanel';
import { DataTable, type DataTableColumnDef, type DataTableFilterDefinition, type DataTableNumberRange } from '@/features/shared/DataTable';
import { useDataTableLabels } from '@/features/shared/useDataTableLabels';
import { useDataTableUrlState } from '@/features/shared/useDataTableUrlState';
import { deriveAccountOverview } from './accountOverview';
import styles from './AccountBalancesPanel.module.css';

function balanceState(account: AccountSummary): 'due' | 'settled' | 'credit' {
  const balance = BigInt(account.balance.minorUnits);
  if (balance > 0n) return 'due';
  if (balance < 0n) return 'credit';
  return 'settled';
}

type AccountFilterId = 'membershipStatus' | 'balanceState' | 'amount';
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
      id: 'membershipStatus',
      kind: 'multi-select',
      label: t('financeWorkspace.membershipStatus'),
      options: [
        { label: t('financeWorkspace.active'), value: 'ACTIVE' },
        { label: t('financeWorkspace.archived'), value: 'ARCHIVED' },
        { label: t('common.deleted'), value: 'DELETED' },
      ],
    },
    {
      id: 'balanceState',
      kind: 'multi-select',
      label: t('common.status'),
      options: [
        { label: t('financeWorkspace.states.due'), value: 'due' },
        { label: t('financeWorkspace.states.settled'), value: 'settled' },
        { label: t('financeWorkspace.states.credit'), value: 'credit' },
      ],
    },
    { id: 'amount', kind: 'number-range', label: `${t('financeWorkspace.balance')} (${activeGroup.currency})`, maximumLabel: t('dataTable.maximum'), minimumLabel: t('dataTable.minimum'), step: 0.01 },
  ], [activeGroup.currency, t]);
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
  const columns = useMemo<DataTableColumnDef<AccountSummary>[]>(() => [
    {
      accessorKey: 'displayName',
      cell: ({ row }) => <span className={styles.member}><Avatar name={row.original.displayName} size="small" src={row.original.avatarUrl} /><strong>{row.original.displayName}</strong></span>,
      enableSorting: true,
      header: t('common.member'),
      id: 'memberName',
      meta: { label: t('common.member') },
    },
    { accessorKey: 'status', cell: ({ row }) => row.original.status === 'ACTIVE' ? t('financeWorkspace.active') : row.original.status === 'ARCHIVED' ? t('financeWorkspace.archived') : t('common.deleted'), enableSorting: true, header: t('financeWorkspace.membershipStatus'), id: 'membershipStatus', meta: { label: t('financeWorkspace.membershipStatus') } },
    {
      accessorFn: balanceState,
      cell: ({ row }) => { const state = balanceState(row.original); return <span className={`${styles.state} ${styles[state]}`}>{t(`financeWorkspace.states.${state}`)}</span>; },
      enableSorting: true,
      header: t('common.status'),
      id: 'balanceState',
      meta: { label: t('common.status') },
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
        filterDefinitions={filterDefinitions}
        getRowId={(account) => account.membershipId}
        labels={{ ...labels, searchLabel: t('financeWorkspace.search'), searchPlaceholder: t('financeWorkspace.searchPlaceholder') }}
        minTableWidth="720px"
        {...tableState}
      />
    </div>
  );
}
