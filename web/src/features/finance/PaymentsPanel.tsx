import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import CircleDollarSign from 'lucide-react/dist/esm/icons/circle-dollar-sign';
import Plus from 'lucide-react/dist/esm/icons/plus';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import X from 'lucide-react/dist/esm/icons/x';
import { useDeferredValue, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { currencyExponent, formatMoney, majorUnitsInputPattern, majorUnitsPlaceholder, parseMajorUnits } from '@/api/money';
import type { CollectionPage, Payment, PaymentCollectionQuery } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput, TextInput } from '@/components/ui/FormField';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { StatePanel } from '@/components/ui/StatePanel';
import { DataTable, type DataTableColumnDef, type DataTableDateRange, type DataTableFilterDefinition, type DataTableNumberRange } from '@/features/shared/DataTable';
import tableStyles from '@/features/shared/Table.module.css';
import { useDataTableLabels } from '@/features/shared/useDataTableLabels';
import { useDataTableUrlState } from '@/features/shared/useDataTableUrlState';
import styles from './PaymentsPanel.module.css';

const paymentPageSize = 50;
type PaymentFilterId = 'membershipId' | 'method' | 'status' | 'receivedAt' | 'amount';

/**
 * Renders the finance workspace for auditable incoming payments.
 *
 * @returns A localized payment ledger with create and reversal dialogs.
 */
export function PaymentsPanel() {
  const { t } = useTranslation();
  const { activeGroupId, activeGroup } = useActiveGroup();
  const queryClient = useQueryClient();
  const paymentFormId = useId();
  const reversalFormId = useId();
  const accountsQuery = useQuery({ queryKey: ['account-summaries', activeGroupId], queryFn: () => api.getAccountSummaries(activeGroupId) });
  const transactionSettingsQuery = useQuery({ queryKey: ['transaction-settings', activeGroupId], queryFn: () => api.getTransactionSettings(activeGroupId) });
  const labels = useDataTableLabels();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [membershipId, setMembershipId] = useState('');
  const [amount, setAmount] = useState('');
  const [receivedAt, setReceivedAt] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<Payment['method']>('');
  const [reference, setReference] = useState('');
  const [paymentToReverse, setPaymentToReverse] = useState<Payment | null>(null);
  const [reversalReason, setReversalReason] = useState('');
  const filterDefinitions = useMemo<readonly DataTableFilterDefinition<PaymentFilterId>[]>(() => [
    {
      allLabel: t('dataTable.allValues'),
      id: 'membershipId',
      kind: 'select',
      label: t('common.member'),
      options: (accountsQuery.data ?? []).map((account) => ({ label: account.displayName, value: account.membershipId })),
    },
    {
      allLabel: t('dataTable.allValues'),
      id: 'method',
      kind: 'select',
      label: t('finance.paymentType'),
      options: (transactionSettingsQuery.data?.paymentMethods ?? []).map((option) => ({ label: option.label, value: option.id })),
    },
    {
      allLabel: t('dataTable.allValues'),
      id: 'status',
      kind: 'select',
      label: t('common.status'),
      options: [{ label: t('common.booked'), value: 'POSTED' }, { label: t('common.reversed'), value: 'REVERSED' }],
    },
    { fromLabel: t('dataTable.from'), id: 'receivedAt', kind: 'date-range', label: t('common.date'), toLabel: t('dataTable.to') },
    {
      id: 'amount',
      kind: 'number-range',
      label: `${t('common.amount')} (${activeGroup.currency})`,
      maximumLabel: t('dataTable.maximum'),
      minimumLabel: t('dataTable.minimum'),
      step: 0.01,
    },
  ], [accountsQuery.data, activeGroup.currency, t, transactionSettingsQuery.data?.paymentMethods]);
  const tableState = useDataTableUrlState<PaymentFilterId>({
    filterDefinitions,
    initialSorting: [{ id: 'receivedAt', desc: true }],
    namespace: 'payments',
    sortableColumnIds: ['receivedAt', 'memberName', 'method', 'amount', 'status'],
  });
  const deferredSearch = useDeferredValue(tableState.searchValue.trim());
  const collectionQuery = useMemo<PaymentCollectionQuery>(() => {
    const dateRange = tableState.filters.receivedAt as DataTableDateRange | undefined;
    const amountRange = tableState.filters.amount as DataTableNumberRange | undefined;
    const sorting = tableState.sorting[0];
    const toMinorUnits = (value: number | undefined) => value === undefined ? undefined : Math.round(value * (10 ** currencyExponent(activeGroup.currency))).toString();
    return {
      amountMax: toMinorUnits(amountRange?.max),
      amountMin: toMinorUnits(amountRange?.min),
      direction: sorting?.desc === false ? 'asc' : 'desc',
      limit: paymentPageSize,
      membershipId: tableState.filters.membershipId as string | undefined,
      method: tableState.filters.method as string | undefined,
      q: deferredSearch || undefined,
      receivedFrom: dateRange?.from,
      receivedTo: dateRange?.to,
      sort: (sorting?.id ?? 'receivedAt') as PaymentCollectionQuery['sort'],
      status: tableState.filters.status as PaymentCollectionQuery['status'],
    };
  }, [activeGroup.currency, deferredSearch, tableState.filters, tableState.sorting]);
  const paymentsQuery = useInfiniteQuery({
    getNextPageParam: (lastPage: CollectionPage<Payment>) => lastPage.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }): Promise<CollectionPage<Payment>> => api.getPaymentsPage(activeGroupId, { ...collectionQuery, cursor: pageParam }),
    queryKey: ['payments', activeGroupId, 'collection', collectionQuery],
  });
  const payments = useMemo(() => paymentsQuery.data?.pages.flatMap((page) => page.items) ?? [], [paymentsQuery.data]);
  const activeAccounts = accountsQuery.data?.filter((account) => account.status === 'ACTIVE') ?? [];
  const regularAccounts = activeAccounts.filter((account) => !account.isTemporaryGuest);
  const temporaryGuestAccounts = activeAccounts.filter((account) => account.isTemporaryGuest);
  const archivedAccounts = accountsQuery.data?.filter((account) => account.status === 'ARCHIVED') ?? [];
  const deletedAccounts = accountsQuery.data?.filter((account) => account.status === 'DELETED' && BigInt(account.balance.minorUnits) > 0n) ?? [];
  const defaultAccount = regularAccounts[0] ?? temporaryGuestAccounts[0] ?? archivedAccounts[0] ?? deletedAccounts[0];
  const selectedMembershipId = membershipId || defaultAccount?.membershipId || '';
  const reasonMode = transactionSettingsQuery.data?.otherPaymentReasonMode
    ?? (transactionSettingsQuery.data?.otherPaymentReasonRequired ? 'REQUIRED' : 'OPTIONAL');
  const reasonEnabled = reasonMode !== 'OFF';
  const reasonRequired = reasonMode === 'REQUIRED';
  const openRecordDialog = () => {
    setMethod(transactionSettingsQuery.data?.paymentMethods[0]?.id ?? '');
    setDialogOpen(true);
  };
  const invalidateFinancialReads = async () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['payments', activeGroupId] }),
    queryClient.invalidateQueries({ queryKey: ['account-summaries', activeGroupId] }),
    queryClient.invalidateQueries({ queryKey: ['ledger', activeGroupId] }),
    queryClient.invalidateQueries({ queryKey: ['settlements', activeGroupId] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard', activeGroupId] }),
  ]);
  const paymentMutation = useMutation({
    mutationFn: () => api.createPayment(activeGroupId, { membershipId: selectedMembershipId, amount: { minorUnits: parseMajorUnits(amount, activeGroup.currency), currency: activeGroup.currency }, receivedAt, method, reference: reasonEnabled ? reference.trim() || undefined : undefined }),
    onSuccess: async () => {
      setDialogOpen(false);
      setAmount('');
      setReference('');
      await invalidateFinancialReads();
    },
  });
  const reversalMutation = useMutation({
    mutationFn: () => paymentToReverse ? api.reversePayment(activeGroupId, paymentToReverse.id, reversalReason.trim()) : Promise.reject(new Error(t('finance.noPaymentSelected'))),
    onSuccess: async () => {
      setPaymentToReverse(null);
      setReversalReason('');
      await invalidateFinancialReads();
    },
  });

  const columns = useMemo<DataTableColumnDef<Payment>[]>(() => [
    {
      accessorKey: 'receivedAt',
      cell: ({ row }) => <time dateTime={row.original.receivedAt}>{new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(row.original.receivedAt))}</time>,
      enableSorting: true,
      header: t('common.date'),
      id: 'receivedAt',
      meta: { label: t('common.date') },
    },
    {
      accessorKey: 'memberName',
      cell: ({ row }) => <><strong>{row.original.memberName}</strong>{row.original.membershipStatus === 'DELETED' ? <span className={tableStyles.status}>{t('common.deleted')}</span> : null}</>,
      enableSorting: true,
      header: t('common.member'),
      id: 'memberName',
      meta: { label: t('common.member') },
    },
    { accessorKey: 'methodLabel', enableSorting: true, header: t('finance.paymentType'), id: 'method', meta: { label: t('finance.paymentType') } },
    { accessorKey: 'reference', cell: ({ row }) => row.original.reference ?? '–', enableSorting: false, header: t('finance.reason'), id: 'reference', meta: { label: t('finance.reason') } },
    {
      accessorFn: (payment) => payment.amount.minorUnits,
      cell: ({ row }) => formatMoney(row.original.amount),
      enableSorting: true,
      header: t('common.amount'),
      id: 'amount',
      meta: { align: 'end', label: t('common.amount') },
    },
    {
      accessorKey: 'status',
      cell: ({ row }) => <span className={`${tableStyles.status} ${row.original.status === 'REVERSED' ? tableStyles.statusMuted : ''}`}>{row.original.status === 'POSTED' ? t('common.booked') : t('common.reversed')}</span>,
      enableSorting: true,
      header: t('common.status'),
      id: 'status',
      meta: { label: t('common.status') },
    },
    {
      cell: ({ row }) => row.original.status === 'POSTED' ? <Button leadingIcon={<RotateCcw size={16} />} onClick={() => setPaymentToReverse(row.original)} size="small" variant="ghost">{t('finance.reverse')}</Button> : null,
      enableSorting: false,
      header: () => <span className="sr-only">{t('common.action')}</span>,
      id: 'action',
      meta: { label: t('common.action') },
    },
  ], [t]);

  if (accountsQuery.isLoading || transactionSettingsQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (!accountsQuery.data || !transactionSettingsQuery.data) return <div className={styles.state}><StatePanel kind="error" message={t('finance.error')} /></div>;

  const total = payments.filter((payment) => payment.status === 'POSTED').reduce((sum, payment) => sum + BigInt(payment.amount.minorUnits), 0n);
  return (
    <div className={styles.content}>
      <header className={styles.header}><div><h2>{t('finance.title')}</h2><p>{t('finance.intro')}</p></div><Button leadingIcon={<Plus size={18} />} onClick={openRecordDialog}>{t('finance.record')}</Button></header>
      <section className={styles.summary}><CircleDollarSign aria-hidden="true" size={28} /><div><span>{t('finance.recorded')}</span><strong>{formatMoney({ minorUnits: total.toString(), currency: activeGroup.currency })}</strong></div><small>{t('finance.transactionCount', { count: payments.length })}</small></section>
      <DataTable
        ariaLabel={t('finance.title')}
        columns={columns}
        data={payments}
        emptyContent={paymentsQuery.isError ? t('finance.error') : t('finance.empty')}
        filterDefinitions={filterDefinitions}
        getRowId={(payment) => payment.id}
        hasMore={paymentsQuery.hasNextPage}
        isLoading={paymentsQuery.isLoading}
        isLoadingMore={paymentsQuery.isFetchingNextPage}
        labels={{ ...labels, searchLabel: t('finance.searchLabel'), searchPlaceholder: t('finance.searchPlaceholder') }}
        minTableWidth="980px"
        onLoadMore={() => void paymentsQuery.fetchNextPage()}
        {...tableState}
      />
      <Modal onClose={() => setDialogOpen(false)} open={dialogOpen} title={t('finance.record')}>
        <form className={styles.form} id={paymentFormId} onSubmit={(event) => { event.preventDefault(); paymentMutation.mutate(); }}>
          <Field htmlFor="payment-member" label={t('common.member')}>
            <SelectInput id="payment-member" onChange={(event) => setMembershipId(event.target.value)} value={membershipId || defaultAccount?.membershipId}>
              {regularAccounts.length > 0 ? <optgroup label={t('booking.regularMembers')}>{regularAccounts.map((account) => <option key={account.membershipId} value={account.membershipId}>{account.displayName}</option>)}</optgroup> : null}
              {temporaryGuestAccounts.length > 0 ? <optgroup label={t('booking.guests')}>{temporaryGuestAccounts.map((account) => <option key={account.membershipId} value={account.membershipId}>{account.displayName}</option>)}</optgroup> : null}
              {archivedAccounts.length > 0 ? <optgroup label={t('financeWorkspace.archivedMembers')}>{archivedAccounts.map((account) => <option key={account.membershipId} value={account.membershipId}>{account.displayName}</option>)}</optgroup> : null}
              {deletedAccounts.length > 0 ? <optgroup label={t('financeWorkspace.deletedAccounts')}>{deletedAccounts.map((account) => <option key={account.membershipId} value={account.membershipId}>{account.displayName}</option>)}</optgroup> : null}
            </SelectInput>
          </Field>
          <div className={styles.formRow}><Field htmlFor="payment-amount" label={`${t('finance.amountIn', { currency: activeGroup.currency })} *`}><TextInput id="payment-amount" inputMode="decimal" onChange={(event) => setAmount(event.target.value)} pattern={majorUnitsInputPattern(activeGroup.currency)} placeholder={majorUnitsPlaceholder(activeGroup.currency)} required type="text" value={amount} /></Field><Field htmlFor="payment-date" label={t('finance.receivedDate')}><TextInput id="payment-date" onChange={(event) => setReceivedAt(event.target.value)} required type="date" value={receivedAt} /></Field></div>
          <Field htmlFor="payment-method" label={t('finance.paymentType')}><SelectInput id="payment-method" onChange={(event) => setMethod(event.target.value)} required value={method}>{transactionSettingsQuery.data.paymentMethods.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</SelectInput></Field>
          {reasonEnabled ? <Field htmlFor="payment-reference" label={`${t('finance.reason')}${reasonRequired ? ' *' : ''}`}><TextInput id="payment-reference" list="payment-reason-suggestions" maxLength={120} onChange={(event) => setReference(event.target.value)} required={reasonRequired} value={reference} /><datalist id="payment-reason-suggestions">{transactionSettingsQuery.data.paymentReasons.map((item) => <option key={item.id} value={item.label} />)}</datalist></Field> : null}
          {paymentMutation.isError ? <p className={styles.error} role="alert">{paymentMutation.error.message}</p> : null}
          <ModalFooter><div className={styles.actions}><Button leadingIcon={<X size={17} />} onClick={() => setDialogOpen(false)} variant="secondary">{t('common.cancel')}</Button><Button disabled={!amount || !method || (reasonRequired && !reference.trim()) || paymentMutation.isPending} form={paymentFormId} leadingIcon={<CircleDollarSign size={17} />} type="submit">{t('finance.bookPayment')}</Button></div></ModalFooter>
        </form>
      </Modal>
      <Modal onClose={() => setPaymentToReverse(null)} open={Boolean(paymentToReverse)} title={t('finance.reverseTitle')}>
        <form className={styles.form} id={reversalFormId} onSubmit={(event) => { event.preventDefault(); reversalMutation.mutate(); }}>
          <p className={styles.explanation}>{t('finance.reverseExplanation')}</p>
          <Field htmlFor="payment-reversal-reason" label={t('finance.reason')}><TextInput id="payment-reversal-reason" onChange={(event) => setReversalReason(event.target.value)} required value={reversalReason} /></Field>
          {reversalMutation.isError ? <p className={styles.error} role="alert">{reversalMutation.error.message}</p> : null}
          <ModalFooter><div className={styles.actions}><Button leadingIcon={<X size={17} />} onClick={() => setPaymentToReverse(null)} variant="secondary">{t('common.cancel')}</Button><Button disabled={!reversalReason.trim() || reversalMutation.isPending} form={reversalFormId} leadingIcon={<RotateCcw size={17} />} type="submit">{t('finance.confirmReverse')}</Button></div></ModalFooter>
        </form>
      </Modal>
    </div>
  );
}
