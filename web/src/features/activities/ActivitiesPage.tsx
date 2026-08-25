import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Archive from 'lucide-react/dist/esm/icons/archive';
import BookOpenCheck from 'lucide-react/dist/esm/icons/book-open-check';
import CircleCheck from 'lucide-react/dist/esm/icons/circle-check';
import CircleDollarSign from 'lucide-react/dist/esm/icons/circle-dollar-sign';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import Scale from 'lucide-react/dist/esm/icons/scale';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import X from 'lucide-react/dist/esm/icons/x';
import { useDeferredValue, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { currencyExponent, formatMoney } from '@/api/money';
import type { ActivityCollectionQuery, ActivityEntry, ActivityKind, CollectionPage, MembershipStatus } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PaymentAttachmentAction } from '@/features/finance/PaymentAttachmentAction';
import { CategoryIcon } from '@/features/shared/CategoryIcon';
import { DataTable, type DataTableColumnDef, type DataTableDateRange, type DataTableFilterDefinition, type DataTableNumberRange } from '@/features/shared/DataTable';
import { formatGermanDateTime } from '@/features/shared/dateFormat';
import { createMemberFilterOption } from '@/features/shared/memberFilterOption';
import tableStyles from '@/features/shared/Table.module.css';
import { useDataTableLabels } from '@/features/shared/useDataTableLabels';
import { useDataTableUrlState } from '@/features/shared/useDataTableUrlState';
import styles from './ActivitiesPage.module.css';

const activityPageSize = 50;
type ActivityFilterId = 'kind' | 'targetMembershipId' | 'productId' | 'categoryId' | 'status' | 'occurredAt' | 'amount';

interface MembershipIdentityProps {
  avatarUrl?: string;
  name?: string;
  status?: MembershipStatus;
}

/**
 * Renders a compact historical member identity with lifecycle state.
 *
 * @param props - Current name, avatar projection, and optional membership state.
 * @returns A table-safe identity or a neutral placeholder for system corrections.
 */
function MembershipIdentity({ avatarUrl, name, status }: MembershipIdentityProps) {
  const { t } = useTranslation();
  if (!name) return <span aria-label={t('activities.actorUnavailable')} className={styles.missingActor}>–</span>;
  const statusLabel = status === 'ARCHIVED' ? t('common.archived') : status === 'DELETED' ? t('common.deleted') : undefined;
  const StatusIcon = status === 'ARCHIVED' ? Archive : Trash2;

  return (
    <span className={styles.member}>
      <Avatar name={name} size="small" src={avatarUrl} />
      <span className={styles.memberName} title={name}>{name}</span>
      {statusLabel ? (
        <span
          aria-label={statusLabel}
          className={`${styles.membershipState} ${status === 'DELETED' ? styles.membershipStateDeleted : styles.membershipStateArchived}`}
          role="img"
          title={statusLabel}
        >
          <StatusIcon aria-hidden="true" size={14} />
          <span className={styles.membershipStateText}>{statusLabel}</span>
        </span>
      ) : null}
    </span>
  );
}

/**
 * Renders one transaction kind with an icon-only narrow-screen state.
 *
 * @param props - Unified activity kind.
 * @returns An accessible booking, payment, or adjustment badge.
 */
function ActivityType({ kind }: Pick<ActivityEntry, 'kind'>) {
  const { t } = useTranslation();
  const label = kind === 'BOOKING' ? t('activities.bookingType') : kind === 'PAYMENT' ? t('activities.paymentType') : t('activities.adjustmentType');
  const TypeIcon = kind === 'BOOKING' ? BookOpenCheck : kind === 'PAYMENT' ? CircleDollarSign : Scale;
  const tone = kind === 'BOOKING' ? styles.activityTypeBooking : kind === 'PAYMENT' ? styles.activityTypePayment : styles.activityTypeAdjustment;

  return (
    <span aria-label={label} className={`${styles.activityType} ${tone}`} role="img" title={label}>
      <TypeIcon aria-hidden="true" size={16} />
      <span aria-hidden="true" className={styles.activityTypeText}>{label}</span>
    </span>
  );
}

/**
 * Renders the source-aware current lifecycle status of one transaction.
 *
 * @param props - Transaction kind and current status.
 * @returns A localized status badge.
 */
function ActivityState({ kind, status }: Pick<ActivityEntry, 'kind' | 'status'>) {
  const { t } = useTranslation();
  const reversed = status === 'REVERSED';
  const label = reversed
    ? t('common.reversed')
    : kind === 'BOOKING' ? t('common.booked') : kind === 'PAYMENT' ? t('activities.paymentReceived') : t('activities.adjustmentPosted');
  const StatusIcon = reversed ? RotateCcw : CircleCheck;
  const tone = reversed ? tableStyles.statusMuted : kind === 'BOOKING' ? tableStyles.statusWarning : '';
  return (
    <span aria-label={label} className={`${tableStyles.status} ${styles.activityState} ${tone}`} role="img" title={label}>
      <StatusIcon aria-hidden="true" size={15} />
      <span>{label}</span>
    </span>
  );
}

/**
 * Renders the unified account transaction history with server-side pagination.
 *
 * @returns A permission-aware activity table and available reversal workflow.
 */
export function ActivitiesPage() {
  const { t } = useTranslation();
  const { activeGroup, activeGroupId, session } = useActiveGroup();
  const queryClient = useQueryClient();
  const reversalFormId = useId();
  const filterOptionsQuery = useQuery({ queryKey: ['activities', activeGroupId, 'filter-options'], queryFn: () => api.getActivityFilterOptions(activeGroupId) });
  const [reversal, setReversal] = useState<ActivityEntry | null>(null);
  const [reason, setReason] = useState('');
  const labels = useDataTableLabels();
  const memberFilterOptions = useMemo(
    () => (filterOptionsQuery.data?.members ?? []).map(createMemberFilterOption),
    [filterOptionsQuery.data?.members],
  );
  const categoryIcons = useMemo(
    () => new Map((filterOptionsQuery.data?.categories ?? []).map((category) => [category.categoryId, category.icon] as const)),
    [filterOptionsQuery.data?.categories],
  );
  const filterDefinitions = useMemo<readonly DataTableFilterDefinition<ActivityFilterId>[]>(() => [
    {
      allLabel: t('dataTable.allValues'),
      dropdown: true,
      emptyLabel: t('dataTable.noOptions'),
      id: 'kind',
      kind: 'multi-select',
      label: t('activities.transaction'),
      options: [
        { label: t('activities.bookingType'), value: 'BOOKING', visual: <BookOpenCheck aria-hidden="true" size={19} /> },
        { label: t('activities.paymentType'), value: 'PAYMENT', visual: <CircleDollarSign aria-hidden="true" size={19} /> },
        ...(filterOptionsQuery.data?.kinds.includes('ADJUSTMENT')
          ? [{ label: t('activities.adjustmentType'), value: 'ADJUSTMENT', visual: <Scale aria-hidden="true" size={19} /> }]
          : []),
      ],
    },
    {
      allLabel: t('dataTable.allValues'),
      id: 'targetMembershipId',
      kind: 'select',
      label: t('common.member'),
      options: memberFilterOptions,
    },
    {
      allLabel: t('dataTable.allValues'),
      id: 'categoryId',
      kind: 'multi-select',
      label: t('common.category'),
      dropdown: true,
      emptyLabel: t('dataTable.noOptions'),
      options: (filterOptionsQuery.data?.categories ?? []).map((category) => ({
        label: category.name,
        value: category.categoryId,
        visual: <CategoryIcon icon={category.icon} size={21} />,
      })),
    },
    {
      allLabel: t('dataTable.allValues'),
      dependsOn: 'categoryId',
      dropdown: true,
      emptyLabel: t('activities.noProductsForCategories'),
      id: 'productId',
      kind: 'multi-select',
      label: t('common.product'),
      options: (filterOptionsQuery.data?.products ?? []).map((product) => ({
        label: product.name,
        parentValues: [product.categoryId],
        value: product.productId,
        visual: product.imageUrl
          ? <img alt="" decoding="async" loading="lazy" src={product.imageUrl} />
          : <CategoryIcon icon={categoryIcons.get(product.categoryId) ?? 'other'} size={21} />,
      })),
    },
    {
      allLabel: t('dataTable.allValues'),
      id: 'status',
      kind: 'select',
      label: t('common.status'),
      options: [{ label: t('common.active'), value: 'POSTED' }, { label: t('common.reversed'), value: 'REVERSED' }],
    },
    { fromLabel: t('dataTable.from'), id: 'occurredAt', kind: 'date-range', label: t('activities.time'), toLabel: t('dataTable.to') },
    {
      formatValue: (value) => {
        const range = value as DataTableNumberRange;
        return [range.min !== undefined ? `${t('dataTable.minimum')}: ${range.min}` : '', range.max !== undefined ? `${t('dataTable.maximum')}: ${range.max}` : ''].filter(Boolean).join(' · ');
      },
      id: 'amount',
      kind: 'number-range',
      label: `${t('common.amount')} (${activeGroup.currency})`,
      maximumLabel: t('dataTable.maximum'),
      minimumLabel: t('dataTable.minimum'),
      step: 0.01,
    },
  ], [activeGroup.currency, categoryIcons, filterOptionsQuery.data?.categories, filterOptionsQuery.data?.kinds, filterOptionsQuery.data?.products, memberFilterOptions, t]);
  const tableState = useDataTableUrlState<ActivityFilterId>({
    filterDefinitions,
    initialSorting: [{ id: 'occurredAt', desc: true }],
    namespace: 'activities',
    sortableColumnIds: ['kind', 'targetName', 'actorName', 'detailName', 'categoryName', 'occurredAt', 'amount', 'status'],
  });
  const deferredSearch = useDeferredValue(tableState.searchValue.trim());
  const collectionQuery = useMemo<ActivityCollectionQuery>(() => {
    const dateRange = tableState.filters.occurredAt as DataTableDateRange | undefined;
    const amountRange = tableState.filters.amount as DataTableNumberRange | undefined;
    const categoryIds = Array.isArray(tableState.filters.categoryId) ? tableState.filters.categoryId : undefined;
    const productIds = Array.isArray(tableState.filters.productId) ? tableState.filters.productId : undefined;
    const kinds = Array.isArray(tableState.filters.kind) ? tableState.filters.kind as ActivityKind[] : undefined;
    const sorting = tableState.sorting[0];
    const toMinorUnits = (value: number | undefined) => value === undefined ? undefined : Math.round(value * (10 ** currencyExponent(activeGroup.currency))).toString();
    return {
      amountMax: toMinorUnits(amountRange?.max),
      amountMin: toMinorUnits(amountRange?.min),
      categoryId: categoryIds,
      direction: sorting?.desc === false ? 'asc' : 'desc',
      kind: kinds,
      limit: activityPageSize,
      occurredFrom: dateRange?.from,
      occurredTo: dateRange?.to,
      productId: productIds,
      q: deferredSearch || undefined,
      sort: (sorting?.id ?? 'occurredAt') as ActivityCollectionQuery['sort'],
      status: tableState.filters.status as ActivityCollectionQuery['status'],
      targetMembershipId: tableState.filters.targetMembershipId as string | undefined,
    };
  }, [activeGroup.currency, deferredSearch, tableState.filters, tableState.sorting]);
  const activitiesQuery = useInfiniteQuery({
    getNextPageParam: (lastPage: CollectionPage<ActivityEntry>) => lastPage.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }): Promise<CollectionPage<ActivityEntry>> => api.getActivitiesPage(activeGroupId, { ...collectionQuery, cursor: pageParam }),
    queryKey: ['activities', activeGroupId, 'collection', collectionQuery],
  });
  const activities = useMemo(() => activitiesQuery.data?.pages.flatMap((page) => page.items) ?? [], [activitiesQuery.data?.pages]);
  const productImages = useMemo(() => new Map(
    filterOptionsQuery.data?.products.map((product) => [product.productId, product.imageUrl] as const) ?? [],
  ), [filterOptionsQuery.data?.products]);
  const invalidateActivityReads = async () => Promise.all([
    ['activities', activeGroupId],
    ['bookings', activeGroupId],
    ['payments', activeGroupId],
    ['dashboard', activeGroupId],
    ['ledger', activeGroupId],
    ['settlements', activeGroupId],
    ['account-summaries', activeGroupId],
  ].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  const reverseMutation = useMutation({
    mutationFn: async () => {
      if (!reversal) throw new Error(t('activities.noSelection'));
      if (reversal.kind === 'BOOKING') {
        await api.reverseBooking(activeGroupId, reversal.sourceId, reason.trim());
        return;
      }
      if (reversal.kind === 'PAYMENT') {
        await api.reversePayment(activeGroupId, reversal.sourceId, reason.trim());
        return;
      }
      throw new Error(t('activities.noSelection'));
    },
    onSuccess: async () => {
      setReversal(null);
      setReason('');
      await invalidateActivityReads();
    },
  });
  const columns = useMemo<DataTableColumnDef<ActivityEntry>[]>(() => [
    {
      accessorKey: 'kind',
      cell: ({ row }) => <ActivityType kind={row.original.kind} />,
      enableSorting: true,
      header: t('activities.transaction'),
      id: 'kind',
      meta: { label: t('activities.transaction') },
    },
    {
      accessorKey: 'targetDisplayName',
      cell: ({ row }) => <MembershipIdentity avatarUrl={row.original.targetMembershipId === activeGroup.membership?.id ? session.user.avatarUrl : row.original.targetAvatarUrl} name={row.original.targetDisplayName} status={row.original.targetMembershipStatus} />,
      enableSorting: true,
      header: t('common.member'),
      id: 'targetName',
      meta: { label: t('common.member') },
    },
    {
      accessorKey: 'actorDisplayName',
      cell: ({ row }) => <MembershipIdentity avatarUrl={row.original.actorMembershipId === activeGroup.membership?.id ? session.user.avatarUrl : row.original.actorAvatarUrl} name={row.original.actorDisplayName} status={row.original.actorMembershipStatus} />,
      enableSorting: true,
      header: t('activities.recordedBy'),
      id: 'actorName',
      meta: { label: t('activities.recordedBy') },
    },
    {
      accessorKey: 'detailName',
      cell: ({ row }) => {
        const activity = row.original;
        const productImageUrl = activity.productId ? productImages.get(activity.productId) : undefined;
        return <span className={styles.activityDetails}>{productImageUrl ? <img alt="" decoding="async" loading="lazy" src={productImageUrl} /> : null}<span><strong>{activity.detailName}</strong>{activity.quantity && activity.quantity > 1 ? ` × ${activity.quantity}` : ''}{activity.detailNote ? <small>{activity.detailNote}</small> : null}</span></span>;
      },
      enableSorting: true,
      header: t('common.details'),
      id: 'detailName',
      meta: { label: t('common.details') },
    },
    { accessorKey: 'categoryName', cell: ({ row }) => row.original.categoryName ?? '–', enableSorting: true, header: t('common.category'), id: 'categoryName', meta: { label: t('common.category') } },
    {
      accessorKey: 'occurredAt',
      cell: ({ row }) => <time dateTime={row.original.occurredAt}>{formatGermanDateTime(row.original.occurredAt)}</time>,
      enableSorting: true,
      header: t('activities.time'),
      id: 'occurredAt',
      meta: { label: t('activities.time') },
    },
    {
      accessorFn: (activity) => activity.amount.minorUnits,
      cell: ({ row }) => {
        const activity = row.original;
        const amount = BigInt(activity.amount.minorUnits);
        const formatted = formatMoney(activity.amount);
        const tone = activity.status === 'REVERSED'
          ? styles.activityAmountReversed
          : amount > 0n ? styles.activityAmountBooking : amount < 0n ? styles.activityAmountPayment : '';
        return <strong className={`${styles.activityAmount} ${tone}`}>{amount > 0n ? `+${formatted}` : formatted}</strong>;
      },
      enableSorting: true,
      header: t('common.amount'),
      id: 'amount',
      meta: { align: 'end', label: t('common.amount') },
    },
    {
      accessorKey: 'status',
      cell: ({ row }) => <ActivityState kind={row.original.kind} status={row.original.status} />,
      enableSorting: true,
      header: t('common.status'),
      id: 'status',
      meta: { label: t('common.status') },
    },
    {
      cell: ({ row }) => {
        const activity = row.original;
        if (!activity.attachment && !activity.canReverse) return null;
        return <div className={styles.rowActions}>{activity.attachment ? <PaymentAttachmentAction attachment={activity.attachment} groupId={activeGroupId} paymentId={activity.sourceId} /> : null}{activity.canReverse ? <Button leadingIcon={<RotateCcw size={16} />} onClick={() => setReversal(activity)} size="small" variant="ghost">{t('activities.reverse')}</Button> : null}</div>;
      },
      enableSorting: false,
      header: () => <span className="sr-only">{t('common.action')}</span>,
      id: 'action',
      meta: { label: t('common.action') },
    },
  ], [activeGroup.membership?.id, activeGroupId, productImages, session.user.avatarUrl, t]);

  const reversingPayment = reversal?.kind === 'PAYMENT';
  return (
    <Page className={styles.page} title={t('activities.title')} wide>
      <div className={styles.activityList}>
        <DataTable
          ariaLabel={t('activities.title')}
          columns={columns}
          data={activities}
          emptyContent={activitiesQuery.isError ? t('activities.error') : t('activities.noResults')}
          fillAvailableHeight
          filterDefinitions={filterDefinitions}
          getRowId={(activity) => activity.id}
          hasMore={activitiesQuery.hasNextPage}
          isLoading={activitiesQuery.isLoading}
          isLoadingMore={activitiesQuery.isFetchingNextPage}
          labels={{ ...labels, searchLabel: t('activities.searchLabel'), searchPlaceholder: t('activities.searchPlaceholder') }}
          minTableWidth="1480px"
          onLoadMore={() => void activitiesQuery.fetchNextPage()}
          {...tableState}
        />
      </div>
      <Modal onClose={() => { setReversal(null); setReason(''); }} open={Boolean(reversal)} title={t(reversingPayment ? 'finance.reverseTitle' : 'activities.reverseTitle')} variant="sheet">
        <form className={styles.reversalForm} id={reversalFormId} onSubmit={(event) => { event.preventDefault(); reverseMutation.mutate(); }}>
          <p>{t(reversingPayment ? 'finance.reverseExplanation' : 'activities.reverseExplanation')}</p>
          {reversal?.reversalWithoutReasonUntil && !reversal.reversalReasonRequired ? <p className={styles.windowNotice}>{t('activities.reasonOptionalUntil', { time: new Intl.DateTimeFormat('de-DE', { timeStyle: 'short' }).format(new Date(reversal.reversalWithoutReasonUntil)) })}</p> : null}
          <Field hint={reversal?.reversalReasonRequired ? undefined : t('activities.reasonOptional')} htmlFor="reversal-reason" label={`${t('finance.reason')}${reversal?.reversalReasonRequired ? ' *' : ''}`}>
            <TextInput id="reversal-reason" onChange={(event) => setReason(event.target.value)} required={reversal?.reversalReasonRequired} value={reason} />
          </Field>
          {reverseMutation.isError ? <p className={styles.error} role="alert">{reverseMutation.error.message}</p> : null}
          <ModalFooter><div className={styles.actions}><Button leadingIcon={<X size={17} />} onClick={() => { setReversal(null); setReason(''); }} variant="secondary">{t('common.cancel')}</Button><Button disabled={Boolean(reversal?.reversalReasonRequired && !reason.trim()) || reverseMutation.isPending} form={reversalFormId} leadingIcon={<RotateCcw size={17} />} type="submit">{t(reversingPayment ? 'finance.confirmReverse' : 'activities.confirmReverse')}</Button></div></ModalFooter>
        </form>
      </Modal>
    </Page>
  );
}
