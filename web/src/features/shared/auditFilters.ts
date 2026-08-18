import type { TFunction } from 'i18next';
import type { AuditFilterOptions } from '@/api/types';
import type { DataTableFilterDefinition } from './DataTable';

/** Filter identifiers supported by group and system audit collections. */
export type AuditEventFilterId = 'action' | 'resourceType' | 'occurredAt';

/**
 * Builds the shared searchable multi-select filters from server-discovered
 * values so both audit scopes expose every persisted action and resource type.
 *
 * @param t - Active localization function.
 * @param options - Complete filter catalog returned for the authorized scope.
 * @returns Typed filter definitions in stable display order.
 */
export function createAuditFilterDefinitions(t: TFunction, options?: AuditFilterOptions): readonly DataTableFilterDefinition<AuditEventFilterId>[] {
  const toOptions = (values: readonly string[] = []) => values.map((value) => ({ label: value, value }));
  return [
    { allLabel: t('audit.allActions'), dropdown: true, emptyLabel: t('audit.noActions'), id: 'action', kind: 'multi-select', label: t('audit.action'), noResultsLabel: t('audit.noMatchingOptions'), options: toOptions(options?.actions), searchLabel: t('audit.searchActions') },
    { allLabel: t('audit.allResourceTypes'), dropdown: true, emptyLabel: t('audit.noResourceTypes'), id: 'resourceType', kind: 'multi-select', label: t('audit.resourceType'), noResultsLabel: t('audit.noMatchingOptions'), options: toOptions(options?.resourceTypes), searchLabel: t('audit.searchResourceTypes') },
    { fromLabel: t('dataTable.from'), id: 'occurredAt', kind: 'date-range', label: t('audit.time'), toLabel: t('dataTable.to') },
  ];
}
