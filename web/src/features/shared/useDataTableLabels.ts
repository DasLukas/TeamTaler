import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { DataTableLabels } from './DataTable';

/**
 * Creates the shared German copy contract consumed by every TeamTaler data table.
 *
 * @returns Stable localized labels for search, filtering, sorting, pagination, and mobile scrolling.
 *
 * @example
 * const labels = useDataTableLabels();
 * <DataTable labels={labels} {...tableProps} />
 */
export function useDataTableLabels(): DataTableLabels {
  const { t } = useTranslation();
  return useMemo(() => ({
    applyFilters: t('dataTable.applyFilters'),
    clearFilter: (filterLabel: string) => t('dataTable.clearFilter', { filter: filterLabel }),
    clearSearch: t('dataTable.clearSearch'),
    filterButton: t('dataTable.filterButton'),
    filterHeading: t('dataTable.filterHeading'),
    loadMore: t('dataTable.loadMore'),
    loading: t('common.loading'),
    loadingMore: t('dataTable.loadingMore'),
    resetFilters: t('dataTable.resetFilters'),
    results: (loadedCount: number, totalCount?: number) => totalCount === undefined
      ? t('dataTable.loadedResults', { count: loadedCount })
      : t('dataTable.totalResults', { count: totalCount, loaded: loadedCount }),
    scrollHint: t('dataTable.scrollHint'),
    searchLabel: t('dataTable.searchLabel'),
    searchPlaceholder: t('dataTable.searchPlaceholder'),
    sortAscending: (columnLabel: string) => t('dataTable.sortAscending', { column: columnLabel }),
    sortDescending: (columnLabel: string) => t('dataTable.sortDescending', { column: columnLabel }),
  }), [t]);
}
