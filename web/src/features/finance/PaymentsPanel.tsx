import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left';
import CircleCheck from 'lucide-react/dist/esm/icons/circle-check';
import CircleDollarSign from 'lucide-react/dist/esm/icons/circle-dollar-sign';
import Plus from 'lucide-react/dist/esm/icons/plus';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import X from 'lucide-react/dist/esm/icons/x';
import { useDeferredValue, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { currencyExponent, formatMoney, majorUnitsInputPattern, majorUnitsPlaceholder, validatePositiveMajorUnits } from '@/api/money';
import type { AccountSummary, CollectionPage, Payment, PaymentCollectionQuery, PaymentCommand } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { useInstanceCapabilities } from '@/app/useSession';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput, TextInput } from '@/components/ui/FormField';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { SelectMenu, type SelectMenuOption } from '@/components/ui/SelectMenu';
import { StatePanel } from '@/components/ui/StatePanel';
import { DataTable, type DataTableColumnDef, type DataTableDateRange, type DataTableFilterDefinition, type DataTableNumberRange } from '@/features/shared/DataTable';
import { formatGermanDate } from '@/features/shared/dateFormat';
import { createMemberFilterOption } from '@/features/shared/memberFilterOption';
import { MembershipStateIcon } from '@/features/shared/MembershipStateIcon';
import tableStyles from '@/features/shared/Table.module.css';
import { useDataTableLabels } from '@/features/shared/useDataTableLabels';
import { useDataTableUrlState } from '@/features/shared/useDataTableUrlState';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import styles from './PaymentsPanel.module.css';
import { PaymentAttachmentAction } from './PaymentAttachmentAction';
import { PaymentAttachmentField } from './PaymentAttachmentField';
import { PaymentReviewSummary } from './PaymentReviewSummary';

const paymentPageSize = 50;
type PaymentFilterId = 'membershipId' | 'method' | 'status' | 'receivedAt' | 'amount';
type PaymentDialogStep = 'entry' | 'review';

/**
 * Converts one account summary into an avatar-backed member choice.
 *
 * @param account - Finance-safe member identity and avatar projection.
 * @param group - Optional visible group heading for the member menu.
 * @returns A reusable custom-select option.
 */
function accountSelectOption(account: AccountSummary, group?: string): SelectMenuOption {
  return {
    group,
    label: account.displayName,
    value: account.membershipId,
    visual: <Avatar decorative name={account.displayName} size="small" src={account.avatarUrl} />,
  };
}

/**
 * Renders the finance workspace for auditable incoming payments.
 *
 * @returns A localized payment ledger with create and reversal dialogs.
 */
export function PaymentsPanel() {
  const { t } = useTranslation();
  const { activeGroupId, activeGroup } = useActiveGroup();
  const queryClient = useQueryClient();
  const { attachmentUploadMaxBytes } = useInstanceCapabilities();
  const compact = useMediaQuery('(max-width: 600px)');
  const paymentFormId = useId();
  const reversalFormId = useId();
  const accountsQuery = useQuery({ queryKey: ['account-summaries', activeGroupId], queryFn: () => api.getAccountSummaries(activeGroupId) });
  const transactionSettingsQuery = useQuery({ queryKey: ['transaction-settings', activeGroupId], queryFn: () => api.getTransactionSettings(activeGroupId) });
  const labels = useDataTableLabels();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [paymentStep, setPaymentStep] = useState<PaymentDialogStep>('entry');
  const [membershipId, setMembershipId] = useState('');
  const [amount, setAmount] = useState('');
  const [amountError, setAmountError] = useState('');
  const [receivedAt, setReceivedAt] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<Payment['method']>('');
  const [reference, setReference] = useState('');
  const [referenceError, setReferenceError] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [paymentCommand, setPaymentCommand] = useState<PaymentCommand | null>(null);
  const [paymentToReverse, setPaymentToReverse] = useState<Payment | null>(null);
  const [reversalReason, setReversalReason] = useState('');
  const filterDefinitions = useMemo<readonly DataTableFilterDefinition<PaymentFilterId>[]>(() => [
    {
      allLabel: t('dataTable.allValues'),
      id: 'membershipId',
      kind: 'select',
      label: t('common.member'),
      options: (accountsQuery.data ?? []).map(createMemberFilterOption),
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
  const accountAvatarUrls = useMemo(() => new Map((accountsQuery.data ?? []).map((account) => [account.membershipId, account.avatarUrl])), [accountsQuery.data]);
  const activeAccounts = accountsQuery.data?.filter((account) => account.status === 'ACTIVE') ?? [];
  const regularAccounts = activeAccounts.filter((account) => !account.isTemporaryGuest);
  const temporaryGuestAccounts = activeAccounts.filter((account) => account.isTemporaryGuest);
  const archivedAccounts = accountsQuery.data?.filter((account) => account.status === 'ARCHIVED') ?? [];
  const deletedAccounts = accountsQuery.data?.filter((account) => account.status === 'DELETED' && BigInt(account.balance.minorUnits) > 0n) ?? [];
  const defaultAccount = regularAccounts[0] ?? temporaryGuestAccounts[0] ?? archivedAccounts[0] ?? deletedAccounts[0];
  const selectedMembershipId = membershipId || defaultAccount?.membershipId || '';
  const paymentMemberOptions: readonly SelectMenuOption[] = [
    ...regularAccounts.map((account) => accountSelectOption(account, t('booking.regularMembers'))),
    ...temporaryGuestAccounts.map((account) => accountSelectOption(account, t('booking.guests'))),
    ...archivedAccounts.map((account) => accountSelectOption(account, t('financeWorkspace.archivedMembers'))),
    ...deletedAccounts.map((account) => accountSelectOption(account, t('financeWorkspace.deletedAccounts'))),
  ];
  const reasonMode = transactionSettingsQuery.data?.otherPaymentReasonMode
    ?? (transactionSettingsQuery.data?.otherPaymentReasonRequired ? 'REQUIRED' : 'OPTIONAL');
  const reasonEnabled = reasonMode !== 'OFF';
  const reasonRequired = reasonMode === 'REQUIRED';
  const selectedPaymentMethod = transactionSettingsQuery.data?.paymentMethods.find((item) => item.id === method);
  const attachmentMode = selectedPaymentMethod?.attachmentMode ?? 'OFF';
  const invalidateFinancialReads = async () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['activities', activeGroupId] }),
    queryClient.invalidateQueries({ queryKey: ['payments', activeGroupId] }),
    queryClient.invalidateQueries({ queryKey: ['account-summaries', activeGroupId] }),
    queryClient.invalidateQueries({ queryKey: ['ledger', activeGroupId] }),
    queryClient.invalidateQueries({ queryKey: ['settlements', activeGroupId] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard', activeGroupId] }),
  ]);
  const resetPaymentDraft = () => {
    setPaymentStep('entry');
    setMembershipId('');
    setAmount('');
    setAmountError('');
    setReceivedAt(new Date().toISOString().slice(0, 10));
    setMethod(transactionSettingsQuery.data?.paymentMethods[0]?.id ?? '');
    setReference('');
    setReferenceError('');
    setAttachment(null);
    setPaymentCommand(null);
  };
  const paymentMutation = useMutation({
    mutationFn: ({ input, file }: { input: PaymentCommand; file: File | null }) => file
      ? api.createPayment(activeGroupId, input, file)
      : api.createPayment(activeGroupId, input),
    onSuccess: async () => {
      setDialogOpen(false);
      resetPaymentDraft();
      await invalidateFinancialReads();
    },
  });
  const openRecordDialog = () => {
    paymentMutation.reset();
    resetPaymentDraft();
    setDialogOpen(true);
  };
  const closeRecordDialog = () => {
    setDialogOpen(false);
    paymentMutation.reset();
    resetPaymentDraft();
  };
  const preparePaymentReview = () => {
    const validation = validatePositiveMajorUnits(amount, activeGroup.currency);
    if (!validation.minorUnits) {
      setAmountError(validation.error ?? t('errors.amountFormat'));
      return;
    }
    const trimmedReference = reference.trim();
    if (reasonRequired && !trimmedReference) {
      setReferenceError(t('finance.referenceRequired'));
      return;
    }
    if (!selectedMembershipId || !method || (attachmentMode === 'REQUIRED' && !attachment)) return;
    setAmountError('');
    setReferenceError('');
    setPaymentCommand({
      amount: { minorUnits: validation.minorUnits, currency: activeGroup.currency },
      membershipId: selectedMembershipId,
      method,
      receivedAt,
      reference: reasonEnabled ? trimmedReference || undefined : undefined,
    });
    setPaymentStep('review');
  };
  const reversalMutation = useMutation({
    mutationFn: () => paymentToReverse ? api.reversePayment(activeGroupId, paymentToReverse.id, reversalReason.trim()) : Promise.reject(new Error(t('finance.noPaymentSelected'))),
    onSuccess: async () => {
      setPaymentToReverse(null);
      setReversalReason('');
      await invalidateFinancialReads();
    },
  });

  const reviewPaymentMember = paymentCommand
    ? accountsQuery.data?.find((account) => account.membershipId === paymentCommand.membershipId)?.displayName ?? paymentCommand.membershipId
    : '';
  const reviewPaymentMethod = paymentCommand
    ? transactionSettingsQuery.data?.paymentMethods.find((item) => item.id === paymentCommand.method)?.label ?? paymentCommand.method
    : '';

  const columns = useMemo<DataTableColumnDef<Payment>[]>(() => [
    {
      accessorKey: 'receivedAt',
      cell: ({ row }) => <time dateTime={row.original.receivedAt}>{formatGermanDate(row.original.receivedAt)}</time>,
      enableSorting: true,
      header: t('common.date'),
      id: 'receivedAt',
      meta: { label: t('common.date') },
    },
    {
      accessorKey: 'memberName',
      cell: ({ row }) => <span className={styles.member}><Avatar name={row.original.memberName} size="small" src={accountAvatarUrls.get(row.original.membershipId)} /><strong>{row.original.memberName}</strong><MembershipStateIcon status={row.original.membershipStatus} /></span>,
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
      cell: ({ row }) => <div className={styles.rowActions}>
        {row.original.attachment ? <PaymentAttachmentAction attachment={row.original.attachment} groupId={activeGroupId} paymentId={row.original.id} /> : null}
        {row.original.status === 'POSTED' ? <Button leadingIcon={<RotateCcw size={16} />} onClick={() => setPaymentToReverse(row.original)} size="small" variant="ghost">{t('finance.reverse')}</Button> : null}
      </div>,
      enableSorting: false,
      header: () => <span className="sr-only">{t('common.action')}</span>,
      id: 'action',
      meta: { label: t('common.action') },
    },
  ], [accountAvatarUrls, activeGroupId, t]);

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
        exportConfig={{
          disabled: deferredSearch !== tableState.searchValue.trim(),
          groupId: activeGroupId,
          query: { ...collectionQuery, limit: undefined },
          table: 'PAYMENTS',
          title: t('finance.title'),
        }}
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
      <Modal onClose={closeRecordDialog} open={dialogOpen} title={t(paymentStep === 'entry' ? 'finance.record' : 'finance.reviewTitle')} variant={compact ? 'sheet' : 'dialog'}>
        {paymentStep === 'entry' ? (
          <form className={styles.form} id={paymentFormId} onSubmit={(event) => { event.preventDefault(); preparePaymentReview(); }}>
            <Field htmlFor="payment-member" label={t('common.member')}>
              <SelectMenu ariaLabel={t('common.member')} id="payment-member" onChange={setMembershipId} options={paymentMemberOptions} value={selectedMembershipId} />
            </Field>
            <div className={styles.formRow}><Field error={amountError || undefined} htmlFor="payment-amount" label={`${t('finance.amountIn', { currency: activeGroup.currency })} *`}><TextInput id="payment-amount" inputMode="decimal" onChange={(event) => { setAmount(event.target.value); setAmountError(''); }} pattern={majorUnitsInputPattern(activeGroup.currency)} placeholder={majorUnitsPlaceholder(activeGroup.currency)} required type="text" value={amount} /></Field><Field htmlFor="payment-date" label={t('finance.receivedDate')}><TextInput id="payment-date" onChange={(event) => setReceivedAt(event.target.value)} required type="date" value={receivedAt} /></Field></div>
            <Field htmlFor="payment-method" label={t('finance.paymentType')}><SelectInput id="payment-method" onChange={(event) => { const nextMethod = event.target.value; setMethod(nextMethod); if (transactionSettingsQuery.data.paymentMethods.find((item) => item.id === nextMethod)?.attachmentMode === 'OFF') setAttachment(null); }} required value={method}>{transactionSettingsQuery.data.paymentMethods.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</SelectInput></Field>
            {reasonEnabled ? <Field error={referenceError || undefined} htmlFor="payment-reference" label={`${t('finance.reason')}${reasonRequired ? ' *' : ''}`}><TextInput id="payment-reference" list="payment-reason-suggestions" maxLength={120} onChange={(event) => { setReference(event.target.value); setReferenceError(''); }} required={reasonRequired} value={reference} /><datalist id="payment-reason-suggestions">{transactionSettingsQuery.data.paymentReasons.map((item) => <option key={item.id} value={item.label} />)}</datalist></Field> : null}
            <PaymentAttachmentField attachmentMode={attachmentMode} file={attachment} maxBytes={attachmentUploadMaxBytes} onChange={setAttachment} />
            <ModalFooter><div className={styles.actions}><Button leadingIcon={<X size={17} />} onClick={closeRecordDialog} variant="secondary">{t('common.cancel')}</Button><Button disabled={!amount || !selectedMembershipId || !method || (reasonRequired && !reference.trim()) || (attachmentMode === 'REQUIRED' && !attachment)} form={paymentFormId} leadingIcon={<CircleCheck size={17} />} type="submit">{t('finance.reviewPayment')}</Button></div></ModalFooter>
          </form>
        ) : null}
        {paymentStep === 'review' && paymentCommand ? (
          <div className={styles.review}>
            <PaymentReviewSummary
              accountLabel={t('common.member')}
              accountName={reviewPaymentMember}
              amount={paymentCommand.amount}
              amountLabel={t('common.amount')}
              attachmentLabel={t('paymentAttachment.label', { defaultValue: 'Receipt' })}
              attachmentName={attachment?.name}
              dateLabel={t('common.date')}
              intro={t('finance.reviewIntro')}
              methodLabel={t('finance.paymentType')}
              methodName={reviewPaymentMethod}
              reason={paymentCommand.reference}
              reasonLabel={t('finance.reason')}
              receivedAt={paymentCommand.receivedAt}
              showReason={reasonEnabled}
            />
            {paymentMutation.isError ? <p className={styles.error} role="alert">{paymentMutation.error.message}</p> : null}
            <ModalFooter><div className={styles.actions}><Button disabled={paymentMutation.isPending} leadingIcon={<ArrowLeft size={17} />} onClick={() => { paymentMutation.reset(); setPaymentStep('entry'); }} variant="secondary">{t('common.back')}</Button><Button disabled={paymentMutation.isPending} leadingIcon={<CircleDollarSign size={17} />} onClick={() => paymentMutation.mutate({ input: paymentCommand, file: attachment })}>{paymentMutation.isPending ? t('finance.paymentPending') : t('finance.confirmPayment', { amount: formatMoney(paymentCommand.amount) })}</Button></div></ModalFooter>
          </div>
        ) : null}
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
