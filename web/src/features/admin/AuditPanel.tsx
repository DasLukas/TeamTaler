import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useDeferredValue, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { AuditCollectionQuery, AuditEntry, CollectionPage } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { AuditEventTable } from '@/features/shared/AuditEventTable';
import { createAuditFilterDefinitions, mergeAuditFilterOptions, type AuditEventFilterId } from '@/features/shared/auditFilters';
import type { DataTableDateRange } from '@/features/shared/DataTable';
import { useDataTableUrlState } from '@/features/shared/useDataTableUrlState';
import styles from './AuditPanel.module.css';

const auditPageSize = 50;

/**
 * Renders the read-only audit log for administrative and finance actions.
 *
 * @returns A localized immutable-event table or query state.
 */
export function AuditPanel() {
  const { t } = useTranslation();
  const { activeGroupId } = useActiveGroup();
  const filterOptionsQuery = useQuery({ queryFn: () => api.getAuditFilterOptions(activeGroupId), queryKey: ['audit', activeGroupId, 'filter-options'] });
  const queryFilterDefinitions = useMemo(() => createAuditFilterDefinitions(t, filterOptionsQuery.data), [filterOptionsQuery.data, t]);
  const tableState = useDataTableUrlState<AuditEventFilterId>({
    filterDefinitions: queryFilterDefinitions,
    initialSorting: [{ id: 'occurredAt', desc: true }],
    namespace: 'group-audit',
    sortableColumnIds: ['occurredAt', 'actorName', 'action', 'resourceType'],
  });
  const deferredSearch = useDeferredValue(tableState.searchValue.trim());
  const collectionQuery = useMemo<AuditCollectionQuery>(() => {
    const dateRange = tableState.filters.occurredAt as DataTableDateRange | undefined;
    const sorting = tableState.sorting[0];
    return {
      action: tableState.filters.action as string[] | undefined,
      direction: sorting?.desc === false ? 'asc' : 'desc',
      limit: auditPageSize,
      occurredFrom: dateRange?.from,
      occurredTo: dateRange?.to,
      q: deferredSearch || undefined,
      resourceType: tableState.filters.resourceType as string[] | undefined,
      sort: (sorting?.id ?? 'occurredAt') as AuditCollectionQuery['sort'],
    };
  }, [deferredSearch, tableState.filters, tableState.sorting]);
  const auditQuery = useInfiniteQuery({
    getNextPageParam: (lastPage: CollectionPage<AuditEntry>) => lastPage.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }): Promise<CollectionPage<AuditEntry>> => api.getAuditPage(activeGroupId, { ...collectionQuery, cursor: pageParam }),
    queryKey: ['audit', activeGroupId, 'collection', collectionQuery],
  });
  const entries = useMemo(() => auditQuery.data?.pages.flatMap((page) => page.items).map((entry) => ({ ...entry, actor: entry.actorName })) ?? [], [auditQuery.data]);
  const visibleFilterOptions = useMemo(() => mergeAuditFilterOptions(
    filterOptionsQuery.data,
    entries.map((entry) => ({ action: entry.action, resourceType: entry.resourceType })),
  ), [entries, filterOptionsQuery.data]);
  const filterDefinitions = useMemo(() => createAuditFilterDefinitions(t, visibleFilterOptions), [t, visibleFilterOptions]);
  return (
    <div className={styles.content}>
      <header><h2>{t('audit.title')}</h2><p>{t('audit.intro')}</p></header>
      <AuditEventTable
        emptyMessage={auditQuery.isError ? t('audit.error') : t('audit.empty')}
        entries={entries}
        filterDefinitions={filterDefinitions}
        hasMore={auditQuery.hasNextPage}
        isLoading={auditQuery.isLoading}
        isLoadingMore={auditQuery.isFetchingNextPage}
        onLoadMore={() => void auditQuery.fetchNextPage()}
        tableState={tableState}
        title={t('audit.title')}
      />
    </div>
  );
}
