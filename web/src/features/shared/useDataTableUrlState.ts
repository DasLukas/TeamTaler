import { useCallback, useEffect, useRef, useState } from 'react';
import type { OnChangeFn, SortingState, Updater } from '@tanstack/react-table';
import {
  type DataTableDateRange,
  type DataTableFilterDefinition,
  type DataTableFilterState,
  type DataTableFilterValue,
  type DataTableNumberRange,
} from './DataTable';
import { isDataTableFilterActive } from './dataTableFilters';

/** History behavior used when the table writes its current query state. */
export type DataTableUrlHistoryMode = 'replace' | 'push';

/** Options accepted by {@link useDataTableUrlState}. */
export interface UseDataTableUrlStateOptions<FilterId extends string = string> {
  /** Stable table-specific namespace that prevents collisions with other tables on the page. */
  namespace: string;
  filterDefinitions?: readonly DataTableFilterDefinition<FilterId>[];
  historyMode?: DataTableUrlHistoryMode;
  initialFilters?: DataTableFilterState<FilterId>;
  initialSearch?: string;
  initialSorting?: SortingState;
  /** Optional allowlist used to discard stale or manipulated sort column identifiers. */
  sortableColumnIds?: readonly string[];
}

/** URL-backed controlled state and handlers accepted directly by {@link DataTable}. */
export interface DataTableUrlState<FilterId extends string = string> {
  filters: DataTableFilterState<FilterId>;
  onFiltersChange: (filters: DataTableFilterState<FilterId>) => void;
  onSearchChange: (search: string) => void;
  onSortingChange: OnChangeFn<SortingState>;
  searchValue: string;
  sorting: SortingState;
}

interface InternalUrlState<FilterId extends string> {
  filters: DataTableFilterState<FilterId>;
  searchValue: string;
  sorting: SortingState;
}

interface UrlParameterNames {
  filters: string;
  search: string;
  sorting: string;
}

/** Creates collision-free search parameter names for one table instance. */
function createParameterNames(namespace: string): UrlParameterNames {
  const prefix = `tt.${namespace}`;
  return {
    filters: `${prefix}.filters`,
    search: `${prefix}.search`,
    sorting: `${prefix}.sorting`,
  };
}

/** Returns whether a parsed range is an object rather than an array or null. */
function isRangeObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses and validates one URL filter value against its discriminated definition. */
function parseFilterValue<FilterId extends string>(definition: DataTableFilterDefinition<FilterId>, value: unknown): DataTableFilterValue | undefined {
  if (definition.kind === 'text') return typeof value === 'string' ? value : undefined;
  if (definition.kind === 'select') {
    if (typeof value !== 'string') return undefined;
    return definition.options.length === 0 || definition.options.some((option) => option.value === value) ? value : undefined;
  }
  if (definition.kind === 'multi-select') {
    if (!Array.isArray(value)) return undefined;
    const allowedValues = new Set(definition.options.map((option) => option.value));
    const selectedValues = value.filter((item): item is string => typeof item === 'string' && allowedValues.has(item));
    return selectedValues.length > 0 ? [...new Set(selectedValues)] : undefined;
  }
  if (!isRangeObject(value)) return undefined;
  if (definition.kind === 'date-range') {
    const range: DataTableDateRange = {
      from: typeof value.from === 'string' ? value.from : undefined,
      to: typeof value.to === 'string' ? value.to : undefined,
    };
    return isDataTableFilterActive(range) ? range : undefined;
  }
  const minimum = typeof value.min === 'number' && Number.isFinite(value.min) ? value.min : undefined;
  const maximum = typeof value.max === 'number' && Number.isFinite(value.max) ? value.max : undefined;
  const range: DataTableNumberRange = { min: minimum, max: maximum };
  return isDataTableFilterActive(range) ? range : undefined;
}

/** Parses filter JSON while discarding unknown identifiers and invalid typed values. */
function parseFilters<FilterId extends string>(rawValue: string | null, definitions: readonly DataTableFilterDefinition<FilterId>[], fallback: DataTableFilterState<FilterId>): DataTableFilterState<FilterId> {
  if (!rawValue) return fallback;
  try {
    const parsed: unknown = JSON.parse(rawValue);
    if (!isRangeObject(parsed)) return fallback;
    const filters: DataTableFilterState<FilterId> = {};
    for (const definition of definitions) {
      const value = parseFilterValue(definition, parsed[definition.id]);
      if (value !== undefined && isDataTableFilterActive(value)) filters[definition.id] = value;
    }
    return filters;
  } catch {
    return fallback;
  }
}

/** Parses a single-column sorting state from the URL. */
function parseSorting(rawValue: string | null, allowedColumnIds: readonly string[] | undefined, fallback: SortingState): SortingState {
  if (!rawValue) return fallback;
  try {
    const parsed: unknown = JSON.parse(rawValue);
    if (!Array.isArray(parsed) || parsed.length === 0) return [];
    const first = parsed[0];
    if (!isRangeObject(first) || typeof first.id !== 'string' || typeof first.desc !== 'boolean') return fallback;
    if (allowedColumnIds && !allowedColumnIds.includes(first.id)) return fallback;
    return [{ id: first.id, desc: first.desc }];
  } catch {
    return fallback;
  }
}

/** Reads one namespaced table state from the current browser URL. */
function readUrlState<FilterId extends string>(options: UseDataTableUrlStateOptions<FilterId>): InternalUrlState<FilterId> {
  const fallback: InternalUrlState<FilterId> = {
    filters: options.initialFilters ?? {},
    searchValue: options.initialSearch ?? '',
    sorting: options.initialSorting ?? [],
  };
  if (typeof window === 'undefined') return fallback;
  const parameters = new URLSearchParams(window.location.search);
  const names = createParameterNames(options.namespace);
  return {
    filters: parseFilters(parameters.get(names.filters), options.filterDefinitions ?? [], fallback.filters),
    searchValue: parameters.get(names.search) ?? fallback.searchValue,
    sorting: parseSorting(parameters.get(names.sorting), options.sortableColumnIds, fallback.sorting),
  };
}

/** Writes one table namespace without modifying parameters owned by the page or other tables. */
function writeUrlState<FilterId extends string>(namespace: string, historyMode: DataTableUrlHistoryMode, state: InternalUrlState<FilterId>): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const names = createParameterNames(namespace);
  if (state.searchValue) url.searchParams.set(names.search, state.searchValue);
  else url.searchParams.delete(names.search);
  const filterValues = Object.values(state.filters) as (DataTableFilterValue | undefined)[];
  if (filterValues.some((value) => isDataTableFilterActive(value))) url.searchParams.set(names.filters, JSON.stringify(state.filters));
  else url.searchParams.delete(names.filters);
  if (state.sorting.length > 0) url.searchParams.set(names.sorting, JSON.stringify(state.sorting.slice(0, 1)));
  else url.searchParams.delete(names.sorting);
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  if (historyMode === 'push') window.history.pushState(window.history.state, '', nextUrl);
  else window.history.replaceState(window.history.state, '', nextUrl);
}

/** Resolves a TanStack raw value or functional state updater. */
function resolveUpdater<Value>(updater: Updater<Value>, current: Value): Value {
  return typeof updater === 'function' ? (updater as (value: Value) => Value)(current) : updater;
}

/** Compares normalized table state before scheduling a history-driven React update. */
function tableStatesMatch<FilterId extends string>(left: InternalUrlState<FilterId>, right: InternalUrlState<FilterId>): boolean {
  return left.searchValue === right.searchValue
    && JSON.stringify(left.filters) === JSON.stringify(right.filters)
    && JSON.stringify(left.sorting) === JSON.stringify(right.sorting);
}

/**
 * Persists controlled search, filter, and single-column sorting state in namespaced URL parameters.
 *
 * The default `replace` mode avoids one browser-history entry per keystroke while preserving the
 * complete table state across reloads, shared links, navigation away, and browser Back navigation.
 * Use a different namespace for every table rendered on the same route.
 *
 * @param options - Namespace, typed filter definitions, defaults, sort allowlist, and history behavior.
 * @returns Controlled state and callbacks that can be spread onto a {@link DataTable}.
 *
 * @example
 * const tableState = useDataTableUrlState({ namespace: 'payments', filterDefinitions, sortableColumnIds: ['occurredAt', 'amount'] });
 * <DataTable {...tableState} columns={columns} data={rows} />
 */
export function useDataTableUrlState<FilterId extends string = string>(options: UseDataTableUrlStateOptions<FilterId>): DataTableUrlState<FilterId> {
  if (!options.namespace.trim()) throw new Error('Data table URL state requires a non-empty namespace.');
  const optionsRef = useRef(options);
  const initializedHistoryRef = useRef(false);
  const skipNextHistoryWriteRef = useRef(false);
  const [state, setState] = useState<InternalUrlState<FilterId>>(() => readUrlState(options));
  const namespace = options.namespace;
  const historyMode = options.historyMode ?? 'replace';

  useEffect(() => {
    if (skipNextHistoryWriteRef.current) {
      skipNextHistoryWriteRef.current = false;
      return;
    }
    writeUrlState(namespace, initializedHistoryRef.current ? historyMode : 'replace', state);
    initializedHistoryRef.current = true;
  }, [historyMode, namespace, state]);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    const synchronizeFromHistory = () => {
      const nextState = readUrlState(optionsRef.current);
      setState((current) => {
        if (tableStatesMatch(current, nextState)) return current;
        skipNextHistoryWriteRef.current = true;
        return nextState;
      });
    };
    window.addEventListener('popstate', synchronizeFromHistory);
    return () => window.removeEventListener('popstate', synchronizeFromHistory);
  }, []);

  const onFiltersChange = useCallback((filters: DataTableFilterState<FilterId>) => {
    setState((current) => ({ ...current, filters }));
  }, []);
  const onSearchChange = useCallback((searchValue: string) => {
    setState((current) => ({ ...current, searchValue }));
  }, []);
  const onSortingChange = useCallback<OnChangeFn<SortingState>>((updater) => {
    setState((current) => ({ ...current, sorting: resolveUpdater(updater, current.sorting).slice(0, 1) }));
  }, []);

  return {
    filters: state.filters,
    onFiltersChange,
    onSearchChange,
    onSortingChange,
    searchValue: state.searchValue,
    sorting: state.sorting,
  };
}
