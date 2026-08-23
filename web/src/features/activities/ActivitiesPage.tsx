import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Archive from 'lucide-react/dist/esm/icons/archive';
import CircleCheck from 'lucide-react/dist/esm/icons/circle-check';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import X from 'lucide-react/dist/esm/icons/x';
import { useDeferredValue, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { currencyExponent, formatMoney } from '@/api/money';
import type { Booking, BookingCollectionQuery, CollectionPage, MembershipStatus } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { CategoryIcon } from '@/features/shared/CategoryIcon';
import { DataTable, type DataTableColumnDef, type DataTableDateRange, type DataTableFilterDefinition, type DataTableNumberRange } from '@/features/shared/DataTable';
import { formatGermanDateTime } from '@/features/shared/dateFormat';
import tableStyles from '@/features/shared/Table.module.css';
import { useDataTableLabels } from '@/features/shared/useDataTableLabels';
import { useDataTableUrlState } from '@/features/shared/useDataTableUrlState';
import styles from './ActivitiesPage.module.css';

const activityPageSize = 50;
type ActivityFilterId = 'productId' | 'categoryId' | 'status' | 'createdAt' | 'amount';

interface MembershipIdentityProps {
  avatarUrl?: string;
  name: string;
  status: MembershipStatus;
}

/**
 * Renders a compact historical member identity with an accessible lifecycle marker.
 *
 * @param props - The current display name, avatar projection, and membership status.
 * @returns A table-safe identity that exposes archived and deleted states through text and tooltip labels.
 */
function MembershipIdentity({ avatarUrl, name, status }: MembershipIdentityProps) {
  const { t } = useTranslation();
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
 * Renders a compact booking status that expands to a labeled badge on wide screens.
 *
 * @param props - The immutable booking status rendered in the activity table.
 * @returns An icon badge with an accessible label and native hover tooltip.
 */
function BookingState({ status }: Pick<Booking, 'status'>) {
  const { t } = useTranslation();
  const label = status === 'POSTED' ? t('common.booked') : t('common.reversed');
  const StatusIcon = status === 'POSTED' ? CircleCheck : RotateCcw;

  return (
    <span
      aria-label={label}
      className={`${tableStyles.status} ${styles.bookingState} ${status === 'REVERSED' ? tableStyles.statusMuted : ''}`}
      role="img"
      title={label}
    >
      <StatusIcon aria-hidden="true" size={15} />
      <span className={styles.bookingStateText}>{label}</span>
    </span>
  );
}

/**
 * Renders a searchable and auditable booking activity page.
 *
 * @returns A localized booking table and reversal workflow.
 */
export function ActivitiesPage() {
  const { t } = useTranslation();
  const { activeGroup, activeGroupId, session } = useActiveGroup();
  const queryClient = useQueryClient();
  const reversalFormId = useId();
  const categoriesQuery = useQuery({ queryKey: ['categories', activeGroupId], queryFn: () => api.getCategories(activeGroupId) });
  const [reversal, setReversal] = useState<Booking | null>(null);
  const [reason, setReason] = useState('');
  const labels = useDataTableLabels();
  const filterDefinitions = useMemo<readonly DataTableFilterDefinition<ActivityFilterId>[]>(() => [
    {
      allLabel: t('dataTable.allValues'),
      id: 'categoryId',
      kind: 'multi-select',
      label: t('common.category'),
      dropdown: true,
      emptyLabel: t('dataTable.noOptions'),
      options: (categoriesQuery.data ?? []).map((category) => ({
        label: category.name,
        value: category.id,
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
      options: (categoriesQuery.data ?? []).flatMap((category) => category.products.map((product) => ({
        label: product.name,
        parentValues: [category.id],
        value: product.id,
        visual: product.imageUrl
          ? <img alt="" decoding="async" loading="lazy" src={product.imageUrl} />
          : <CategoryIcon icon={category.icon} size={21} />,
      }))),
    },
    {
      allLabel: t('dataTable.allValues'),
      id: 'status',
      kind: 'select',
      label: t('common.status'),
      options: [{ label: t('common.booked'), value: 'POSTED' }, { label: t('common.reversed'), value: 'VOIDED' }],
    },
    { fromLabel: t('dataTable.from'), id: 'createdAt', kind: 'date-range', label: t('activities.time'), toLabel: t('dataTable.to') },
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
  ], [activeGroup.currency, categoriesQuery.data, t]);
  const tableState = useDataTableUrlState<ActivityFilterId>({
    filterDefinitions,
    initialSorting: [{ id: 'createdAt', desc: true }],
    namespace: 'activities',
    sortableColumnIds: ['targetName', 'actorName', 'productName', 'categoryName', 'createdAt', 'amount', 'status'],
  });
  const deferredSearch = useDeferredValue(tableState.searchValue.trim());
  const collectionQuery = useMemo<BookingCollectionQuery>(() => {
    const dateRange = tableState.filters.createdAt as DataTableDateRange | undefined;
    const amountRange = tableState.filters.amount as DataTableNumberRange | undefined;
    const categoryIds = Array.isArray(tableState.filters.categoryId) ? tableState.filters.categoryId : undefined;
    const productIds = Array.isArray(tableState.filters.productId) ? tableState.filters.productId : undefined;
    const sorting = tableState.sorting[0];
    const toMinorUnits = (value: number | undefined) => value === undefined ? undefined : Math.round(value * (10 ** currencyExponent(activeGroup.currency))).toString();
    return {
      amountMax: toMinorUnits(amountRange?.max),
      amountMin: toMinorUnits(amountRange?.min),
      categoryId: categoryIds,
      createdFrom: dateRange?.from,
      createdTo: dateRange?.to,
      direction: sorting?.desc === false ? 'asc' : 'desc',
      limit: activityPageSize,
      productId: productIds,
      q: deferredSearch || undefined,
      sort: (sorting?.id ?? 'createdAt') as BookingCollectionQuery['sort'],
      status: tableState.filters.status as BookingCollectionQuery['status'],
    };
  }, [activeGroup.currency, deferredSearch, tableState.filters, tableState.sorting]);
  const bookingsQuery = useInfiniteQuery({
    getNextPageParam: (lastPage: CollectionPage<Booking>) => lastPage.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }): Promise<CollectionPage<Booking>> => api.getBookingsPage(activeGroupId, { ...collectionQuery, cursor: pageParam }),
    queryKey: ['bookings', activeGroupId, 'collection', collectionQuery],
  });
  const bookings = useMemo(() => bookingsQuery.data?.pages.flatMap((page) => page.items) ?? [], [bookingsQuery.data]);
  const productImages = useMemo(() => new Map(
    categoriesQuery.data?.flatMap((category) => category.products.map((product) => [product.id, product.imageUrl] as const)) ?? [],
  ), [categoriesQuery.data]);
  const reverseMutation = useMutation({
    mutationFn: () => reversal ? api.reverseBooking(activeGroupId, reversal.id, reason.trim()) : Promise.reject(new Error(t('activities.noSelection'))),
    onSuccess: async () => {
      setReversal(null);
      setReason('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['bookings', activeGroupId] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard', activeGroupId] }),
        queryClient.invalidateQueries({ queryKey: ['ledger', activeGroupId] }),
        queryClient.invalidateQueries({ queryKey: ['account-summaries', activeGroupId] }),
      ]);
    },
  });

  const columns = useMemo<DataTableColumnDef<Booking>[]>(() => [
    {
      accessorKey: 'memberName',
      cell: ({ row }) => <MembershipIdentity avatarUrl={row.original.memberId === activeGroup.membership?.id ? session.user.avatarUrl : row.original.memberAvatarUrl} name={row.original.memberName} status={row.original.memberStatus} />,
      enableSorting: true,
      header: t('activities.bookedFor'),
      id: 'targetName',
      meta: { label: t('activities.bookedFor') },
    },
    {
      accessorKey: 'bookedByName',
      cell: ({ row }) => <MembershipIdentity avatarUrl={row.original.bookedByMemberId === activeGroup.membership?.id ? session.user.avatarUrl : row.original.bookedByAvatarUrl} name={row.original.bookedByName} status={row.original.bookedByStatus} />,
      enableSorting: true,
      header: t('activities.bookedBy'),
      id: 'actorName',
      meta: { label: t('activities.bookedBy') },
    },
    {
      accessorKey: 'productName',
      cell: ({ row }) => {
        const booking = row.original;
        const productImageUrl = productImages.get(booking.productId);
        return <span className={styles.bookingProduct}>{productImageUrl ? <img alt="" decoding="async" loading="lazy" src={productImageUrl} /> : null}<span><strong>{booking.productName}</strong>{booking.quantity > 1 ? ` × ${booking.quantity}` : ''}{booking.reason ? <small>{booking.reason}</small> : null}</span></span>;
      },
      enableSorting: true,
      header: t('activities.booking'),
      id: 'productName',
      meta: { label: t('activities.booking') },
    },
    { accessorKey: 'categoryName', enableSorting: true, header: t('common.category'), id: 'categoryName', meta: { label: t('common.category') } },
    {
      accessorKey: 'bookedAt',
      cell: ({ row }) => <time dateTime={row.original.bookedAt}>{formatGermanDateTime(row.original.bookedAt)}</time>,
      enableSorting: true,
      header: t('activities.time'),
      id: 'createdAt',
      meta: { label: t('activities.time') },
    },
    {
      accessorFn: (booking) => booking.total.minorUnits,
      cell: ({ row }) => formatMoney(row.original.total),
      enableSorting: true,
      header: t('common.amount'),
      id: 'amount',
      meta: { align: 'end', label: t('common.amount') },
    },
    {
      accessorKey: 'status',
      cell: ({ row }) => <BookingState status={row.original.status} />,
      enableSorting: true,
      header: t('common.status'),
      id: 'status',
      meta: { label: t('common.status') },
    },
    {
      cell: ({ row }) => row.original.status === 'POSTED' && row.original.canVoid ? <Button leadingIcon={<RotateCcw size={16} />} onClick={() => setReversal(row.original)} size="small" variant="ghost">{t('activities.reverse')}</Button> : null,
      enableSorting: false,
      header: () => <span className="sr-only">{t('common.action')}</span>,
      id: 'action',
      meta: { label: t('common.action') },
    },
  ], [activeGroup.membership?.id, productImages, session.user.avatarUrl, t]);

  return (
    <Page className={styles.page} title={t('activities.title')} wide>
      <DataTable
        ariaLabel={t('activities.title')}
        columns={columns}
        data={bookings}
        emptyContent={bookingsQuery.isError ? t('activities.error') : t('activities.noResults')}
        filterDefinitions={filterDefinitions}
        getRowId={(booking) => booking.id}
        hasMore={bookingsQuery.hasNextPage}
        isLoading={bookingsQuery.isLoading}
        isLoadingMore={bookingsQuery.isFetchingNextPage}
        labels={{ ...labels, searchLabel: t('activities.searchLabel'), searchPlaceholder: t('activities.searchPlaceholder') }}
        minTableWidth="1120px"
        onLoadMore={() => void bookingsQuery.fetchNextPage()}
        {...tableState}
      />
      <Modal onClose={() => { setReversal(null); setReason(''); }} open={Boolean(reversal)} title={t('activities.reverseTitle')}>
        <form className={styles.reversalForm} id={reversalFormId} onSubmit={(event) => { event.preventDefault(); reverseMutation.mutate(); }}>
          <p>{t('activities.reverseExplanation')}</p>
          {reversal?.voidWithoutReasonUntil && !reversal.voidReasonRequired ? <p className={styles.windowNotice}>{t('activities.reasonOptionalUntil', { time: new Intl.DateTimeFormat('de-DE', { timeStyle: 'short' }).format(new Date(reversal.voidWithoutReasonUntil)) })}</p> : null}
          <Field hint={reversal?.voidReasonRequired ? t('activities.reasonRequired') : t('activities.reasonOptional')} htmlFor="reversal-reason" label={t('finance.reason')}>
            <TextInput id="reversal-reason" onChange={(event) => setReason(event.target.value)} required={reversal?.voidReasonRequired} value={reason} />
          </Field>
          {reverseMutation.isError ? <p className={styles.error} role="alert">{reverseMutation.error.message}</p> : null}
          <ModalFooter><div className={styles.actions}><Button leadingIcon={<X size={17} />} onClick={() => { setReversal(null); setReason(''); }} variant="secondary">{t('common.cancel')}</Button><Button disabled={Boolean(reversal?.voidReasonRequired && !reason.trim()) || reverseMutation.isPending} form={reversalFormId} leadingIcon={<RotateCcw size={17} />} type="submit">{t('activities.confirmReverse')}</Button></div></ModalFooter>
        </form>
      </Modal>
    </Page>
  );
}
