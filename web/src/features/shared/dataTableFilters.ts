import type { DataTableFilterDefinition, DataTableFilterState, DataTableFilterValue } from './DataTable';

/**
 * Determines whether a typed filter value changes the result set.
 *
 * @param value - Candidate value from controlled state.
 * @returns Whether the value represents an active filter.
 */
export function isDataTableFilterActive(value: DataTableFilterValue | undefined): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (!value) return false;
  return Object.values(value).some((boundary) => boundary !== undefined && boundary !== '');
}

/**
 * Returns the options currently permitted by a dependent multi-select filter.
 *
 * An empty parent selection deliberately exposes every child option. Once one
 * or more parents are selected, only children mapped to those parents remain.
 *
 * @param definition - Multi-select definition and its optional parent identifier.
 * @param filters - Current draft or applied filter state.
 * @returns The subset of options permitted by the current parent selection.
 */
export function availableDataTableFilterOptions<FilterId extends string>(
  definition: Extract<DataTableFilterDefinition<FilterId>, { kind: 'multi-select' }>,
  filters: DataTableFilterState<FilterId>,
) {
  if (!definition.dependsOn) return definition.options;
  const parentValue = filters[definition.dependsOn];
  const parentValues = Array.isArray(parentValue) ? parentValue : typeof parentValue === 'string' ? [parentValue] : [];
  if (parentValues.length === 0) return definition.options;
  const selectedParents = new Set(parentValues);
  return definition.options.filter((option) => !option.parentValues || option.parentValues.some((value) => selectedParents.has(value)));
}

/**
 * Removes child selections that are not available for the selected parent filters.
 *
 * @param filters - Candidate filter state, usually the filter-dialog draft.
 * @param definitions - Typed definitions describing parent-child relationships.
 * @returns A normalized copy without impossible dependent selections.
 */
export function normalizeDataTableFilters<FilterId extends string>(
  filters: DataTableFilterState<FilterId>,
  definitions: readonly DataTableFilterDefinition<FilterId>[],
): DataTableFilterState<FilterId> {
  const normalized = { ...filters };
  definitions.forEach((definition) => {
    if (definition.kind !== 'multi-select' || !definition.dependsOn) return;
    if (definition.options.length === 0) return;
    const selectedValues = normalized[definition.id];
    if (!Array.isArray(selectedValues)) return;
    const allowedValues = new Set(availableDataTableFilterOptions(definition, normalized).map((option) => option.value));
    const nextValues = selectedValues.filter((value) => allowedValues.has(value));
    if (nextValues.length > 0) normalized[definition.id] = nextValues;
    else delete normalized[definition.id];
  });
  return normalized;
}
