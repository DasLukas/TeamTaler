import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left';
import ArrowUpDown from 'lucide-react/dist/esm/icons/arrow-up-down';
import BookOpenCheck from 'lucide-react/dist/esm/icons/book-open-check';
import CircleDollarSign from 'lucide-react/dist/esm/icons/circle-dollar-sign';
import LayoutList from 'lucide-react/dist/esm/icons/layout-list';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import Scale from 'lucide-react/dist/esm/icons/scale';
import Table2 from 'lucide-react/dist/esm/icons/table-2';
import X from 'lucide-react/dist/esm/icons/x';
import { useCallback, useDeferredValue, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { currencyExponent } from '@/api/money';
import type { ActivityCollectionQuery, ActivityEntry, ActivityKind, CollectionPage } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { SelectMenu, type SelectMenuOption } from '@/components/ui/SelectMenu';
import { CategoryIcon } from '@/features/shared/CategoryIcon';
import { DataTable, type DataTableCardView, type DataTableColumnDef, type DataTableDateRange, type DataTableFilterDefinition, type DataTableNumberRange, type DataTableRowFocus } from '@/features/shared/DataTable';
import { formatGermanDateTime } from '@/features/shared/dateFormat';
import { createMemberFilterOption } from '@/features/shared/memberFilterOption';
import { useDataTableLabels } from '@/features/shared/useDataTableLabels';
import { useDataTableUrlState } from '@/features/shared/useDataTableUrlState';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { ActivityActions, ActivityAmount, ActivityCard, ActivityDetails, ActivityState, ActivityType, MembershipIdentity } from './ActivityEntryPresentation';
import { useActivityFocusNavigation } from './useActivityFocusNavigation';
import styles from './ActivitiesPage.module.css';

const activityPageSize = 50;
const activityViewStorageKey = 'teamtaler:activities-view:v1';
type ActivityFilterId = 'kind' | 'targetMembershipId' | 'productId' | 'categoryId' | 'status' | 'occurredAt' | 'amount';
type ActivitySortId = 'kind' | 'targetName' | 'actorName' | 'detailName' | 'categoryName' | 'occurredAt' | 'amount' | 'status';
type MobileActivityView = 'cards' | 'table';

/**
 * Reads the versioned mobile activity-view preference with a card-first fallback.
 *
 * @returns The persisted table or card mode, defaulting to cards when storage is unavailable.
 */
function readMobileActivityView(): MobileActivityView {
  try {
    return window.localStorage.getItem(activityViewStorageKey) === 'table' ? 'table' : 'cards';
  } catch {
    return 'cards';
  }
}

/**
 * Persists the mobile activity-view preference without making storage availability a runtime requirement.
 *
 * @param view - Card or table representation selected on this device.
 * @returns Nothing.
 */
function persistMobileActivityView(view: MobileActivityView): void {
  try {
    window.localStorage.setItem(activityViewStorageKey, view);
  } catch {
    // The current in-memory preference remains usable when browser storage is blocked.
  }
}

/**
 * Renders the unified account transaction history with server-side pagination.
 *
 * @returns A permission-aware activity table and available reversal workflow.
 */
export function ActivitiesPage() {
  const { t } = useTranslation();
  const { activeGroup, activeGroupId, session } = useActiveGroup();
  const compact = useMediaQuery('(max-width: 767px)');
  const queryClient = useQueryClient();
  const activityViewportRef = useRef<HTMLDivElement>(null);
  const loadedActivityIdsRef = useRef<ReadonlySet<string>>(new Set());
  const assignActivityViewport = useCallback((element: HTMLDivElement | null) => {
    activityViewportRef.current = element;
  }, []);
  const reversalFormId = useId();
  const sortFormId = useId();
  const filterOptionsQuery = useQuery({ queryKey: ['activities', activeGroupId, 'filter-options'], queryFn: () => api.getActivityFilterOptions(activeGroupId) });
  const [reversal, setReversal] = useState<ActivityEntry | null>(null);
  const [reason, setReason] = useState('');
  const [mobileView, setMobileView] = useState<MobileActivityView>(readMobileActivityView);
  const [sortDialogOpen, setSortDialogOpen] = useState(false);
  const [draftSortId, setDraftSortId] = useState<ActivitySortId>('occurredAt');
  const [draftSortDescending, setDraftSortDescending] = useState(true);
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
        ...(filterOptionsQuery.data?.kinds.includes('REVERSAL')
          ? [{ label: t('activities.reversalType'), value: 'REVERSAL', visual: <RotateCcw aria-hidden="true" size={19} /> }]
          : []),
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
  const sortOptions = useMemo<readonly SelectMenuOption<ActivitySortId>[]>(() => [
    { label: t('activities.transaction'), value: 'kind' },
    { label: t('common.member'), value: 'targetName' },
    { label: t('activities.recordedBy'), value: 'actorName' },
    { label: t('common.details'), value: 'detailName' },
    { label: t('common.category'), value: 'categoryName' },
    { label: t('activities.time'), value: 'occurredAt' },
    { label: t('common.amount'), value: 'amount' },
    { label: t('common.status'), value: 'status' },
  ], [t]);
  const tableState = useDataTableUrlState<ActivityFilterId>({
    filterDefinitions,
    initialSorting: [{ id: 'occurredAt', desc: true }],
    namespace: 'activities',
    sortableColumnIds: ['kind', 'targetName', 'actorName', 'detailName', 'categoryName', 'occurredAt', 'amount', 'status'],
  });
  const {
    filters: visibleFilters,
    onFiltersChange: setVisibleFilters,
    onSearchChange: setVisibleSearch,
    searchValue: visibleSearchValue,
  } = tableState;
  const {
    anchorId,
    clearFocusForQueryChange,
    focusedActivityId,
    leaveFocus,
    navigateToActivity,
    restorePendingScrollPosition,
  } = useActivityFocusNavigation({ loadedActivityIdsRef, viewportRef: activityViewportRef });
  useLayoutEffect(() => {
    if (!anchorId) return;
    if (visibleSearchValue) setVisibleSearch('');
    if (Object.keys(visibleFilters).length > 0) setVisibleFilters({});
  }, [anchorId, setVisibleFilters, setVisibleSearch, visibleFilters, visibleSearchValue]);
  const cardsActive = compact && mobileView === 'cards';
  const selectReversal = useCallback((activity: ActivityEntry) => setReversal(activity), []);
  const changeMobileView = (view: MobileActivityView) => {
    setMobileView(view);
    persistMobileActivityView(view);
  };
  const openSortDialog = () => {
    const sorting = tableState.sorting[0];
    setDraftSortId((sorting?.id ?? 'occurredAt') as ActivitySortId);
    setDraftSortDescending(sorting?.desc !== false);
    setSortDialogOpen(true);
  };
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
  const activeCollectionQuery = useMemo<ActivityCollectionQuery>(() => anchorId ? {
    anchorId,
    direction: collectionQuery.direction,
    limit: activityPageSize,
    sort: collectionQuery.sort,
  } : collectionQuery, [anchorId, collectionQuery]);
  const activitiesQuery = useInfiniteQuery({
    getNextPageParam: (lastPage: CollectionPage<ActivityEntry>) => lastPage.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }): Promise<CollectionPage<ActivityEntry>> => api.getActivitiesPage(activeGroupId, anchorId && pageParam ? {
      cursor: pageParam,
      direction: activeCollectionQuery.direction,
      limit: activityPageSize,
      sort: activeCollectionQuery.sort,
    } : { ...activeCollectionQuery, cursor: pageParam }),
    queryKey: ['activities', activeGroupId, 'collection', activeCollectionQuery],
  });
  const activities = useMemo(() => activitiesQuery.data?.pages.flatMap((page) => page.items) ?? [], [activitiesQuery.data?.pages]);
  useLayoutEffect(() => {
    loadedActivityIdsRef.current = new Set(activities.map((activity) => activity.id));
  }, [activities]);
  useLayoutEffect(() => {
    if (!activitiesQuery.isLoading) restorePendingScrollPosition();
  }, [activities, activitiesQuery.isLoading, restorePendingScrollPosition]);
  const focusedActivity = useMemo(
    () => activities.find((activity) => activity.id === focusedActivityId),
    [activities, focusedActivityId],
  );
  const rowFocus = useMemo<DataTableRowFocus | undefined>(() => focusedActivityId ? {
    announcement: t('activities.focusAnnouncement', { detail: focusedActivity?.detailName ?? t('activities.focusedEntry') }),
    rowId: focusedActivityId,
  } : undefined, [focusedActivity?.detailName, focusedActivityId, t]);
  const onFiltersChange = useCallback<typeof tableState.onFiltersChange>((filters) => {
    clearFocusForQueryChange();
    tableState.onFiltersChange(filters);
  }, [clearFocusForQueryChange, tableState]);
  const onSearchChange = useCallback((value: string) => {
    clearFocusForQueryChange();
    tableState.onSearchChange(value);
  }, [clearFocusForQueryChange, tableState]);
  const onSortingChange = useCallback<typeof tableState.onSortingChange>((updater) => {
    clearFocusForQueryChange();
    tableState.onSortingChange(updater);
  }, [clearFocusForQueryChange, tableState]);
  const productImages = useMemo(() => new Map(
    filterOptionsQuery.data?.products.map((product) => [product.productId, product.imageUrl] as const) ?? [],
  ), [filterOptionsQuery.data?.products]);
  const renderActivityCard = useCallback((activity: ActivityEntry) => (
    <ActivityCard
      activity={activity}
      actorAvatarUrl={activity.actorMembershipId === activeGroup.membership?.id ? session.user.avatarUrl : activity.actorAvatarUrl}
      groupId={activeGroupId}
      onNavigateRelated={navigateToActivity}
      onReverse={selectReversal}
      productImageUrl={activity.productId ? productImages.get(activity.productId) : undefined}
      targetAvatarUrl={activity.targetMembershipId === activeGroup.membership?.id ? session.user.avatarUrl : activity.targetAvatarUrl}
    />
  ), [activeGroup.membership?.id, activeGroupId, navigateToActivity, productImages, selectReversal, session.user.avatarUrl]);
  const cardView = useMemo<DataTableCardView<ActivityEntry>>(() => ({
    ariaLabel: t('activities.cardsAriaLabel'),
    renderItem: renderActivityCard,
  }), [renderActivityCard, t]);
  const invalidateActivityReads = async () => Promise.all([
    ['activities', activeGroupId],
    ['bookings', activeGroupId],
    ['payments', activeGroupId],
    ['dashboard', activeGroupId],
    ['ledger', activeGroupId],
    ['settlements', activeGroupId],
    ['account-summaries', activeGroupId],
    ['statistics', activeGroupId],
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
        return <ActivityDetails activity={activity} productImageUrl={productImageUrl} />;
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
      cell: ({ row }) => <ActivityAmount amount={row.original.amount} status={row.original.status} />,
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
        return <ActivityActions activity={activity} groupId={activeGroupId} onNavigateRelated={navigateToActivity} onReverse={selectReversal} />;
      },
      enableSorting: false,
      header: () => <span className="sr-only">{t('common.action')}</span>,
      id: 'action',
      meta: { label: t('common.action') },
    },
  ], [activeGroup.membership?.id, activeGroupId, navigateToActivity, productImages, selectReversal, session.user.avatarUrl, t]);

  const reversingPayment = reversal?.kind === 'PAYMENT';
  const emptyContent = focusedActivityId ? (
    <div className={styles.focusRecovery}>
      <span>{t('activities.focusError')}</span>
      <Button leadingIcon={<ArrowLeft size={17} />} onClick={leaveFocus} size="small" variant="secondary">
        {t('activities.focusReturnList')}
      </Button>
    </div>
  ) : activitiesQuery.isError ? t('activities.error') : t('activities.noResults');
  return (
    <Page className={styles.page} title={t('activities.title')} wide>
      <div className={styles.activityList}>
        <DataTable
          ariaLabel={t('activities.title')}
          cardView={cardView}
          columns={columns}
          data={activities}
          emptyContent={emptyContent}
          exportConfig={{
            disabled: deferredSearch !== tableState.searchValue.trim(),
            groupId: activeGroupId,
            query: { ...collectionQuery, limit: undefined },
            table: 'ACTIVITIES',
            title: t('activities.title'),
          }}
          fillAvailableHeight
          filterDefinitions={filterDefinitions}
          getRowId={(activity) => activity.id}
          hasMore={activitiesQuery.hasNextPage}
          isLoading={activitiesQuery.isLoading}
          isLoadingMore={activitiesQuery.isFetchingNextPage}
          labels={{ ...labels, searchLabel: t('activities.searchLabel'), searchPlaceholder: t('activities.searchPlaceholder') }}
          minTableWidth="1680px"
          onFiltersChange={onFiltersChange}
          onLoadMore={() => void activitiesQuery.fetchNextPage()}
          onSearchChange={onSearchChange}
          onSortingChange={onSortingChange}
          rowFocus={rowFocus}
          searchValue={tableState.searchValue}
          sorting={tableState.sorting}
          toolbarActions={compact ? <>
            <Button
              aria-expanded={sortDialogOpen}
              aria-haspopup="dialog"
              aria-label={t('activities.sort.open')}
              iconOnly
              leadingIcon={<ArrowUpDown size={18} />}
              onClick={openSortDialog}
              title={t('activities.sort.open')}
              variant="secondary"
            >
              {t('activities.sort.open')}
            </Button>
            <Button
              aria-label={t(cardsActive ? 'activities.showTable' : 'activities.showCards')}
              iconOnly
              leadingIcon={cardsActive ? <Table2 size={18} /> : <LayoutList size={18} />}
              onClick={() => changeMobileView(cardsActive ? 'table' : 'cards')}
              title={t(cardsActive ? 'activities.showTable' : 'activities.showCards')}
              variant="secondary"
            >
              {t(cardsActive ? 'activities.showTable' : 'activities.showCards')}
            </Button>
          </> : undefined}
          viewMode={cardsActive ? 'cards' : 'table'}
          viewportRef={assignActivityViewport}
          filters={tableState.filters}
        />
      </div>
      <Modal
        footer={<div className={styles.actions}><Button leadingIcon={<X size={17} />} onClick={() => setSortDialogOpen(false)} variant="secondary">{t('common.cancel')}</Button><Button form={sortFormId} leadingIcon={<ArrowUpDown size={17} />} type="submit">{t('activities.sort.apply')}</Button></div>}
        onClose={() => setSortDialogOpen(false)}
        open={sortDialogOpen}
        title={t('activities.sort.title')}
        variant="sheet"
      >
        <form
          className={styles.sortForm}
          id={sortFormId}
          onSubmit={(event) => {
            event.preventDefault();
            onSortingChange([{ id: draftSortId, desc: draftSortDescending }]);
            setSortDialogOpen(false);
          }}
        >
          <Field htmlFor="activity-sort-field" label={t('activities.sort.field')}>
            <SelectMenu ariaLabel={t('activities.sort.field')} id="activity-sort-field" onChange={setDraftSortId} options={sortOptions} value={draftSortId} />
          </Field>
          <fieldset className={styles.sortDirections}>
            <legend>{t('activities.sort.direction')}</legend>
            <label><input checked={!draftSortDescending} name={`${sortFormId}-direction`} onChange={() => setDraftSortDescending(false)} type="radio" /><span>{t('activities.sort.ascending')}</span></label>
            <label><input checked={draftSortDescending} name={`${sortFormId}-direction`} onChange={() => setDraftSortDescending(true)} type="radio" /><span>{t('activities.sort.descending')}</span></label>
          </fieldset>
        </form>
      </Modal>
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
