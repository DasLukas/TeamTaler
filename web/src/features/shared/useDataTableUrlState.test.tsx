import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataTableFilterDefinition } from './DataTable';
import { useDataTableUrlState } from './useDataTableUrlState';

type FilterId = 'status' | 'period';
type DependentFilterId = 'categoryId' | 'productId';

const definitions: readonly DataTableFilterDefinition<FilterId>[] = [
  {
    allLabel: 'All',
    id: 'status',
    kind: 'select',
    label: 'Status',
    options: [{ label: 'Open', value: 'open' }],
  },
  { fromLabel: 'From', id: 'period', kind: 'date-range', label: 'Period', toLabel: 'To' },
];

describe('useDataTableUrlState', () => {
  beforeEach(() => window.history.replaceState({}, '', '/finance?tab=payments'));
  afterEach(() => vi.restoreAllMocks());

  it('persists controlled state in a table-specific namespace without removing page parameters', () => {
    const { result } = renderHook(() => useDataTableUrlState({
      filterDefinitions: definitions,
      namespace: 'payments',
      sortableColumnIds: ['amount'],
    }));

    act(() => {
      result.current.onSearchChange('Ada');
      result.current.onFiltersChange({ status: 'open' });
      result.current.onSortingChange([{ desc: true, id: 'amount' }]);
    });

    const parameters = new URLSearchParams(window.location.search);
    expect(parameters.get('tab')).toBe('payments');
    expect(parameters.get('tt.payments.search')).toBe('Ada');
    expect(JSON.parse(parameters.get('tt.payments.filters') ?? '{}')).toEqual({ status: 'open' });
    expect(JSON.parse(parameters.get('tt.payments.sorting') ?? '[]')).toEqual([{ desc: true, id: 'amount' }]);
  });

  it('restores valid state on reload and ignores another table namespace', () => {
    const filters = encodeURIComponent(JSON.stringify({ period: { from: '2026-08-01' }, status: 'open' }));
    const sorting = encodeURIComponent(JSON.stringify([{ desc: false, id: 'amount' }]));
    window.history.replaceState({}, '', `/finance?tt.payments.search=Ada&tt.payments.filters=${filters}&tt.payments.sorting=${sorting}&tt.audit.search=Admin`);

    const { result } = renderHook(() => useDataTableUrlState({
      filterDefinitions: definitions,
      namespace: 'payments',
      sortableColumnIds: ['amount'],
    }));

    expect(result.current.searchValue).toBe('Ada');
    expect(result.current.filters).toEqual({ period: { from: '2026-08-01' }, status: 'open' });
    expect(result.current.sorting).toEqual([{ desc: false, id: 'amount' }]);
    expect(new URLSearchParams(window.location.search).get('tt.audit.search')).toBe('Admin');
  });

  it('keeps select values while their options are still loading', () => {
    const filters = encodeURIComponent(JSON.stringify({ status: 'open' }));
    window.history.replaceState({}, '', `/finance?tt.payments.filters=${filters}`);
    const loadingDefinitions: readonly DataTableFilterDefinition<FilterId>[] = [
      { allLabel: 'All', id: 'status', kind: 'select', label: 'Status', options: [] },
      definitions[1],
    ];

    const { result } = renderHook(() => useDataTableUrlState({
      filterDefinitions: loadingDefinitions,
      namespace: 'payments',
    }));

    expect(result.current.filters).toEqual({ status: 'open' });
  });

  it('upgrades legacy single values and removes products outside selected categories', () => {
    const dependentDefinitions: readonly DataTableFilterDefinition<DependentFilterId>[] = [
      { id: 'categoryId', kind: 'multi-select', label: 'Category', options: [{ label: 'Snacks', value: 'snacks' }] },
      {
        dependsOn: 'categoryId',
        id: 'productId',
        kind: 'multi-select',
        label: 'Product',
        options: [{ label: 'Water', parentValues: ['drinks'], value: 'water' }],
      },
    ];
    const filters = encodeURIComponent(JSON.stringify({ categoryId: 'snacks', productId: ['water'] }));
    window.history.replaceState({}, '', `/activities?tt.activities.filters=${filters}`);

    const { result } = renderHook(() => useDataTableUrlState({
      filterDefinitions: dependentDefinitions,
      namespace: 'activities',
    }));

    expect(result.current.filters).toEqual({ categoryId: ['snacks'] });
  });

  it('synchronizes state when browser history navigation changes the URL', () => {
    const { result } = renderHook(() => useDataTableUrlState({ filterDefinitions: definitions, namespace: 'payments' }));
    act(() => result.current.onSearchChange('Current'));

    act(() => {
      window.history.replaceState({}, '', '/finance?tt.payments.search=Previous');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(result.current.searchValue).toBe('Previous');
  });

  it('does not create a new push entry while consuming browser history', () => {
    const pushState = vi.spyOn(window.history, 'pushState');
    const { result } = renderHook(() => useDataTableUrlState({
      filterDefinitions: definitions,
      historyMode: 'push',
      namespace: 'payments',
    }));
    expect(pushState).not.toHaveBeenCalled();

    act(() => result.current.onSearchChange('Current'));
    expect(pushState).toHaveBeenCalledOnce();
    pushState.mockClear();

    act(() => {
      window.history.replaceState({}, '', '/finance?tt.payments.search=Previous');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(result.current.searchValue).toBe('Previous');
    expect(pushState).not.toHaveBeenCalled();
  });
});
