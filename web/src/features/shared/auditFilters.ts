import type { TFunction } from 'i18next';
import type { AuditFilterOptions } from '@/api/types';
import type { DataTableFilterDefinition } from './DataTable';

/** Filter identifiers supported by group and system audit collections. */
export type AuditEventFilterId = 'action' | 'resourceType' | 'occurredAt';

/** Minimal persisted event identity used to augment an audit filter catalog. */
export interface AuditFilterEvent {
  action: string;
  resourceType: string;
}

const compareFilterValues = (left: string, right: string) => {
  const leftFolded = left.toLocaleLowerCase();
  const rightFolded = right.toLocaleLowerCase();
  return leftFolded === rightFolded ? left.localeCompare(right) : leftFolded.localeCompare(rightFolded);
};

/**
 * Combines the complete server catalog with currently loaded events.
 *
 * The loaded-event fallback keeps the controls useful while the catalog query
 * is pending, while the server relationship remains authoritative across all
 * pages once available.
 *
 * @param options - Complete server-discovered filter catalog when loaded.
 * @param events - Currently loaded audit action/resource pairs.
 * @returns One sorted, de-duplicated catalog with action-to-resource mappings.
 */
export function mergeAuditFilterOptions(options: AuditFilterOptions | undefined, events: readonly AuditFilterEvent[]): AuditFilterOptions {
  const actions = new Set(options?.actions ?? []);
  const resourceTypes = new Set(options?.resourceTypes ?? []);
  const actionResourceTypes = new Map<string, Set<string>>();

  Object.entries(options?.actionResourceTypes ?? {}).forEach(([action, relatedResourceTypes]) => {
    actions.add(action);
    const relationships = actionResourceTypes.get(action) ?? new Set<string>();
    relatedResourceTypes.forEach((resourceType) => {
      if (!resourceType) return;
      resourceTypes.add(resourceType);
      relationships.add(resourceType);
    });
    actionResourceTypes.set(action, relationships);
  });
  events.forEach(({ action, resourceType }) => {
    if (!action || !resourceType) return;
    actions.add(action);
    resourceTypes.add(resourceType);
    const relationships = actionResourceTypes.get(action) ?? new Set<string>();
    relationships.add(resourceType);
    actionResourceTypes.set(action, relationships);
  });

  return {
    actions: [...actions].sort(compareFilterValues),
    resourceTypes: [...resourceTypes].sort(compareFilterValues),
    actionResourceTypes: Object.fromEntries([...actionResourceTypes].map(([action, relatedResourceTypes]) => [
      action,
      [...relatedResourceTypes].sort(compareFilterValues),
    ])),
  };
}

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
    { allLabel: t('audit.allResourceTypes'), dropdown: true, emptyLabel: t('audit.noResourceTypes'), id: 'resourceType', kind: 'multi-select', label: t('audit.resourceType'), noResultsLabel: t('audit.noMatchingOptions'), options: toOptions(options?.resourceTypes), searchLabel: t('audit.searchResourceTypes') },
    { allLabel: t('audit.allActions'), dependsOn: 'resourceType', dropdown: true, emptyLabel: t('audit.noActions'), id: 'action', kind: 'multi-select', label: t('audit.action'), noResultsLabel: t('audit.noMatchingOptions'), options: (options?.actions ?? []).map((action) => ({ label: action, parentValues: options?.actionResourceTypes?.[action] ?? [], value: action })), searchLabel: t('audit.searchActions') },
    { fromLabel: t('dataTable.from'), id: 'occurredAt', kind: 'date-range', label: t('audit.time'), toLabel: t('dataTable.to') },
  ];
}
