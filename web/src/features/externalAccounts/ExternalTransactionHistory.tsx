import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import CircleCheck from 'lucide-react/dist/esm/icons/circle-check';
import CreditCard from 'lucide-react/dist/esm/icons/credit-card';
import PencilLine from 'lucide-react/dist/esm/icons/pencil-line';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import X from 'lucide-react/dist/esm/icons/x';
import { useCallback, useDeferredValue, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { currencyExponent } from '@/api/money';
import type { CollectionPage, ExternalAccount, ExternalAccountTransaction, ExternalAccountTransactionQuery } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { DataTable, type DataTableCardView, type DataTableColumnDef, type DataTableDateRange, type DataTableFilterDefinition, type DataTableNumberRange } from '@/features/shared/DataTable';
import { PaymentAttachmentAction } from '@/features/finance/PaymentAttachmentAction';
import { formatGermanDate } from '@/features/shared/dateFormat';
import { useDataTableLabels } from '@/features/shared/useDataTableLabels';
import { useDataTableUrlState } from '@/features/shared/useDataTableUrlState';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { ExternalAccountTransactionKindIcon } from './ExternalAccountTransactionKindIcon';
import { ExternalAccountTypeIcon } from './ExternalAccountTypeIcon';
import { ExternalTransactionActor, ExternalTransactionAmount, ExternalTransactionKind, ExternalTransactionStatus } from './ExternalTransactionPresentation';
import { projectTransactionAccounts } from './externalAccountProjection';
import { externalAccountKeys } from './externalAccountQueryKeys';
import styles from './ExternalTransactionHistory.module.css';

const pageSize = 50;
type FilterId = 'accountId' | 'kind' | 'source' | 'status' | 'occurredAt' | 'amount';

interface ExternalTransactionHistoryProps {
  accounts: ExternalAccount[];
  canManage: boolean;
  canOpenPayments: boolean;
  currency: string;
  groupId: string;
  onAccessError: (error: unknown) => boolean;
}

/** Renders cursor-backed, exportable external-account history and reversal actions. */
export function ExternalTransactionHistory({ accounts, canManage, canOpenPayments, currency, groupId, onAccessError }: ExternalTransactionHistoryProps) {
  const { t } = useTranslation();
  const compact = useMediaQuery('(max-width: 720px)');
  const queryClient = useQueryClient();
  const reversalFormId = useId();
  const labels = useDataTableLabels();
  const [reversal, setReversal] = useState<ExternalAccountTransaction>();
  const [reversalReason, setReversalReason] = useState('');
  const filters = useMemo<readonly DataTableFilterDefinition<FilterId>[]>(() => [
    { allLabel: t('dataTable.allValues'), dropdown: true, id: 'accountId', kind: 'multi-select', label: t('externalAccounts.filters.account'), options: accounts.map((account) => ({ label: account.name, value: account.id, visual: <ExternalAccountTypeIcon type={account.type} /> })) },
    { allLabel: t('dataTable.allValues'), dropdown: true, id: 'kind', kind: 'multi-select', label: t('externalAccounts.filters.kind'), options: (['PAYMENT', 'OPENING_BALANCE', 'INCOME', 'EXPENSE', 'TRANSFER', 'ADJUSTMENT', 'REVERSAL'] as const).map((kind) => ({ label: t(`externalAccounts.kinds.${kind}`), value: kind, visual: <ExternalAccountTransactionKindIcon kind={kind} /> })) },
    { allLabel: t('dataTable.allValues'), id: 'source', kind: 'select', label: t('externalAccounts.filters.source'), options: [{ label: t('externalAccounts.sources.MANUAL'), value: 'MANUAL', visual: <PencilLine aria-hidden="true" size={20} /> }, { label: t('externalAccounts.sources.PAYMENT'), value: 'PAYMENT', visual: <CreditCard aria-hidden="true" size={20} /> }] },
    { allLabel: t('dataTable.allValues'), id: 'status', kind: 'select', label: t('common.status'), options: [{ label: t('common.booked'), value: 'POSTED', visual: <CircleCheck aria-hidden="true" size={20} /> }, { label: t('common.reversed'), value: 'REVERSED', visual: <RotateCcw aria-hidden="true" size={20} /> }] },
    { fromLabel: t('dataTable.from'), id: 'occurredAt', kind: 'date-range', label: t('common.date'), toLabel: t('dataTable.to') },
    { id: 'amount', kind: 'number-range', label: `${t('common.amount')} (${currency})`, maximumLabel: t('dataTable.maximum'), minimumLabel: t('dataTable.minimum'), step: 1 / (10 ** currencyExponent(currency)) },
  ], [accounts, currency, t]);
  const tableState = useDataTableUrlState<FilterId>({ filterDefinitions: filters, initialSorting: [{ id: 'occurredAt', desc: true }], namespace: 'external-accounts', sortableColumnIds: ['occurredAt', 'kind', 'amount', 'actorName', 'status'] });
  const deferredSearch = useDeferredValue(tableState.searchValue.trim());
  const collectionQuery = useMemo<ExternalAccountTransactionQuery>(() => {
    const dates = tableState.filters.occurredAt as DataTableDateRange | undefined;
    const amounts = tableState.filters.amount as DataTableNumberRange | undefined;
    const sorting = tableState.sorting[0];
    const toMinor = (value?: number) => value === undefined ? undefined : Math.round(value * 10 ** currencyExponent(currency)).toString();
    return {
      accountId: tableState.filters.accountId as string[] | undefined,
      kind: tableState.filters.kind as ExternalAccountTransactionQuery['kind'],
      source: tableState.filters.source as ExternalAccountTransactionQuery['source'],
      status: tableState.filters.status as ExternalAccountTransactionQuery['status'],
      occurredFrom: dates?.from,
      occurredTo: dates?.to,
      amountMin: toMinor(amounts?.min),
      amountMax: toMinor(amounts?.max),
      q: deferredSearch || undefined,
      limit: pageSize,
      sort: (sorting?.id ?? 'occurredAt') as ExternalAccountTransactionQuery['sort'],
      direction: sorting?.desc === false ? 'asc' : 'desc',
    };
  }, [currency, deferredSearch, tableState.filters, tableState.sorting]);
  const query = useInfiniteQuery({
    queryKey: externalAccountKeys.transactionCollection(groupId, collectionQuery),
    queryFn: async ({ pageParam }): Promise<CollectionPage<ExternalAccountTransaction>> => {
      try {
        return await api.getExternalAccountTransactionsPage(groupId, { ...collectionQuery, cursor: pageParam });
      } catch (error) {
        onAccessError(error);
        throw error;
      }
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
  });
  const transactions = useMemo(() => (query.data?.pages.flatMap((page) => page.items) ?? []).map((item) => projectTransactionAccounts(item, accounts)), [accounts, query.data]);
  const closeReversal = () => { setReversal(undefined); setReversalReason(''); };
  const reversalMutation = useMutation({
    mutationFn: () => reversal ? api.reverseExternalAccountTransaction(groupId, reversal.id, reversalReason.trim()) : Promise.reject(new Error(t('externalAccounts.transactionMissing'))),
    onError: (error) => { onAccessError(error); },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: externalAccountKeys.all(groupId) }); closeReversal(); },
  });
  const transactionActions = useCallback((item: ExternalAccountTransaction) => <div className={styles.actions}>
    {canOpenPayments && item.paymentId ? <a className={styles.link} href={`/finance?tab=payments&paymentId=${encodeURIComponent(item.paymentId)}`}>{t('externalAccounts.openPayment')}</a> : null}
    {item.attachment ? <PaymentAttachmentAction attachment={item.attachment} groupId={groupId} loadAttachment={() => api.getExternalAccountTransactionAttachment(groupId, item.id)} paymentId={item.id} /> : null}
    {canManage && item.canReverse ? <Button leadingIcon={<RotateCcw size={15} />} onClick={() => setReversal(item)} size="small" variant="ghost">{t('finance.reverse')}</Button> : null}
  </div>, [canManage, canOpenPayments, groupId, t]);

  const columns = useMemo<DataTableColumnDef<ExternalAccountTransaction>[]>(() => [
    { accessorKey: 'occurredAt', cell: ({ row }) => <time dateTime={row.original.occurredAt}>{formatGermanDate(row.original.occurredAt)}</time>, enableSorting: true, header: t('common.date'), id: 'occurredAt', meta: { label: t('common.date') } },
    { accessorKey: 'kind', cell: ({ row }) => <ExternalTransactionKind kind={row.original.kind} />, enableSorting: true, header: t('externalAccounts.fields.kind'), id: 'kind', meta: { label: t('externalAccounts.fields.kind') } },
    { cell: ({ row }) => row.original.sourceAccount?.name ?? '–', header: t('externalAccounts.fields.sourceAccount'), id: 'sourceAccount', meta: { label: t('externalAccounts.fields.sourceAccount') } },
    { cell: ({ row }) => row.original.destinationAccount?.name ?? '–', header: t('externalAccounts.fields.destinationAccount'), id: 'destinationAccount', meta: { label: t('externalAccounts.fields.destinationAccount') } },
    { accessorKey: 'reason', header: t('externalAccounts.fields.reason'), id: 'reason', meta: { label: t('externalAccounts.fields.reason') } },
    { accessorFn: (item) => item.amount.minorUnits, cell: ({ row }) => <ExternalTransactionAmount amount={row.original.amount} status={row.original.status} />, enableSorting: true, header: t('common.amount'), id: 'amount', meta: { align: 'end', label: t('common.amount') } },
    { accessorFn: (item) => item.actor.displayName, cell: ({ row }) => <ExternalTransactionActor actor={row.original.actor} />, enableSorting: true, header: t('externalAccounts.actor'), id: 'actorName', meta: { label: t('externalAccounts.actor') } },
    { accessorKey: 'status', cell: ({ row }) => <ExternalTransactionStatus status={row.original.status} />, enableSorting: true, header: t('common.status'), id: 'status', meta: { label: t('common.status') } },
    { cell: ({ row }) => transactionActions(row.original), header: () => <span className="sr-only">{t('common.action')}</span>, id: 'actions', meta: { label: t('common.action') } },
  ], [t, transactionActions]);
  const cardView = useMemo<DataTableCardView<ExternalAccountTransaction>>(() => ({ ariaLabel: t('externalAccounts.history'), renderItem: (item) => <article className={styles.card}><header><ExternalTransactionKind kind={item.kind} /><ExternalTransactionAmount amount={item.amount} status={item.status} /></header><p>{item.reason}</p><div className={styles.cardMeta}><time dateTime={item.occurredAt}>{formatGermanDate(item.occurredAt)}</time><ExternalTransactionActor actor={item.actor} /><ExternalTransactionStatus status={item.status} /></div>{transactionActions(item)}</article> }), [t, transactionActions]);

  return <section aria-labelledby="external-account-history-title" className={styles.section}>
    <header><h2 id="external-account-history-title">{t('externalAccounts.history')}</h2><p>{t('externalAccounts.historyIntro')}</p></header>
    <DataTable ariaLabel={t('externalAccounts.history')} cardView={cardView} columns={columns} data={transactions} emptyContent={query.isError ? t('finance.error') : t('externalAccounts.emptyHistory')} exportConfig={{ disabled: deferredSearch !== tableState.searchValue.trim(), groupId, query: { ...collectionQuery, accountId: undefined, accountIds: collectionQuery.accountId, limit: undefined }, table: 'EXTERNAL_ACCOUNT_TRANSACTIONS', title: t('externalAccounts.history') }} filterDefinitions={filters} getRowId={(item) => item.id} hasMore={query.hasNextPage} isLoading={query.isLoading} isLoadingMore={query.isFetchingNextPage} labels={{ ...labels, searchLabel: t('externalAccounts.searchLabel'), searchPlaceholder: t('externalAccounts.searchPlaceholder') }} minTableWidth="1180px" onLoadMore={() => void query.fetchNextPage()} viewMode={compact ? 'cards' : 'table'} {...tableState} />
    <Modal onClose={closeReversal} open={Boolean(reversal)} title={t('externalAccounts.reverseTitle')} variant={compact ? 'sheet' : 'dialog'}>
      <form className={styles.reversalForm} id={reversalFormId} onSubmit={(event) => { event.preventDefault(); reversalMutation.mutate(); }}><p>{t('externalAccounts.reverseImpact')}</p><Field htmlFor="external-transaction-reversal-reason" label={t('externalAccounts.fields.reversalReason')} required><TextInput id="external-transaction-reversal-reason" maxLength={120} onChange={(event) => setReversalReason(event.target.value)} required value={reversalReason} /></Field>{reversalMutation.isError ? <p className={styles.error} role="alert">{reversalMutation.error.message}</p> : null}<ModalFooter><div className={styles.dialogActions}><Button leadingIcon={<X size={17} />} onClick={closeReversal} variant="secondary">{t('common.cancel')}</Button><Button disabled={!reversalReason.trim() || reversalMutation.isPending} form={reversalFormId} leadingIcon={<RotateCcw size={17} />} type="submit">{t('finance.confirmReverse')}</Button></div></ModalFooter></form>
    </Modal>
  </section>;
}
