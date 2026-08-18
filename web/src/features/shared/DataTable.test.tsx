import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { SortingState } from '@tanstack/react-table';
import { describe, expect, it, vi } from 'vitest';
import {
  DataTable,
  type DataTableColumnDef,
  type DataTableFilterDefinition,
  type DataTableFilterState,
  type DataTableLabels,
} from './DataTable';

interface TestRow {
  amount: number;
  id: string;
  name: string;
  status: string;
}

type TestFilterId = 'status' | 'period';

const columns: DataTableColumnDef<TestRow>[] = [
  { accessorKey: 'name', enableSorting: true, header: 'Name', meta: { label: 'Name' } },
  { accessorKey: 'status', enableSorting: false, header: 'Status', meta: { label: 'Status' } },
  { accessorKey: 'amount', enableSorting: true, header: 'Amount', meta: { align: 'end', label: 'Amount' } },
];

const rows: TestRow[] = [
  { amount: 1200, id: 'row-1', name: 'Ada', status: 'Open' },
  { amount: 400, id: 'row-2', name: 'Grace', status: 'Paid' },
];

const filterDefinitions: readonly DataTableFilterDefinition<TestFilterId>[] = [
  {
    allLabel: 'All statuses',
    id: 'status',
    kind: 'select',
    label: 'Status',
    options: [
      { label: 'Open', value: 'open' },
      { label: 'Paid', value: 'paid' },
    ],
  },
  { fromLabel: 'From', id: 'period', kind: 'date-range', label: 'Period', toLabel: 'To' },
];

const labels: DataTableLabels = {
  applyFilters: 'Apply filters',
  clearFilter: (label) => `Clear ${label}`,
  clearSearch: 'Clear search',
  filterButton: 'Filters',
  filterHeading: 'Filter results',
  loadMore: 'Load more',
  loading: 'Loading results',
  loadingMore: 'Loading more results',
  resetFilters: 'Reset filters',
  results: (loaded, total) => total === undefined ? `${loaded} results` : `${loaded} of ${total} results`,
  scrollHint: 'Scroll horizontally for more columns',
  searchLabel: 'Search payments',
  searchPlaceholder: 'Search all columns',
  sortAscending: (label) => `Sort ${label} ascending`,
  sortDescending: (label) => `Sort ${label} descending`,
};

interface ControlledTableProps {
  hasMore?: boolean;
  onLoadMore?: () => void;
}

/** Supplies controlled query state so interactions can be asserted through the public API. */
function ControlledTable({ hasMore = false, onLoadMore }: ControlledTableProps) {
  const [searchValue, setSearchValue] = useState('');
  const [filters, setFilters] = useState<DataTableFilterState<TestFilterId>>({});
  const [sorting, setSorting] = useState<SortingState>([]);
  return (
    <DataTable
      ariaLabel="Payments"
      columns={columns}
      data={rows}
      emptyContent="No payments"
      filterDefinitions={filterDefinitions}
      filters={filters}
      getRowId={(row) => row.id}
      hasMore={hasMore}
      labels={labels}
      onFiltersChange={setFilters}
      onLoadMore={onLoadMore}
      onSearchChange={setSearchValue}
      onSortingChange={setSorting}
      searchValue={searchValue}
      sorting={sorting}
      totalCount={12}
    />
  );
}

describe('DataTable', () => {
  it('renders semantic rows, search, result feedback, and incremental loading', async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    render(<ControlledTable hasMore onLoadMore={onLoadMore} />);

    const table = screen.getByRole('table', { name: 'Payments' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(screen.getByRole('status')).toHaveTextContent('2 of 12 results');

    await user.type(screen.getByRole('searchbox', { name: 'Search payments' }), 'ada');
    expect(screen.getByRole('searchbox', { name: 'Search payments' })).toHaveValue('ada');
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('searchbox', { name: 'Search payments' })).toHaveValue('');

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it('stages typed filters, applies them together, and exposes removable chips', async () => {
    const user = userEvent.setup();
    render(<ControlledTable />);

    await user.click(screen.getByRole('button', { name: 'Filters' }));
    const dialog = screen.getByRole('dialog', { name: 'Filter results' });
    await user.selectOptions(within(dialog).getByLabelText('Status'), 'open');
    fireEvent.change(within(dialog).getByLabelText('From'), { target: { value: '2026-08-01' } });

    expect(screen.getByRole('button', { name: 'Filters' })).toHaveAccessibleName('Filters');
    await user.click(within(dialog).getByRole('button', { name: 'Apply filters' }));

    const chips = screen.getByRole('list', { name: 'Filter results' });
    expect(within(chips).getByText('Open')).toBeVisible();
    expect(within(chips).getByText(/From: 2026-08-01/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Filters (2)' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Clear Status' }));
    expect(within(chips).queryByText('Open')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(screen.queryByText(/From: 2026-08-01/)).not.toBeInTheDocument();
  });

  it('uses accessible sortable column headers while leaving row order server-controlled', async () => {
    const user = userEvent.setup();
    render(<ControlledTable />);

    const nameHeader = screen.getByRole('columnheader', { name: 'Name' });
    expect(nameHeader).not.toHaveAttribute('aria-sort');
    await user.click(within(nameHeader).getByRole('button', { name: 'Sort Name ascending' }));
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'ascending');
    expect(within(nameHeader).getByRole('button', { name: 'Sort Name descending' })).toBeVisible();
    expect(within(screen.getByRole('table', { name: 'Payments' })).getAllByRole('row')[1]).toHaveTextContent('Ada');
  });

  it('makes horizontal overflow and the current scroll edge visually discoverable', () => {
    render(<ControlledTable />);
    const table = screen.getByRole('table', { name: 'Payments' });
    const viewport = table.closest('[role="region"]');
    expect(viewport).not.toBeNull();
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 400 },
      scrollWidth: { configurable: true, value: 1000 },
    });

    fireEvent(window, new Event('resize'));
    expect(viewport).toHaveAttribute('tabindex', '0');
    expect(viewport?.parentElement).toHaveAttribute('data-scroll-position', 'start');
    expect(screen.getByText('Scroll horizontally for more columns')).not.toHaveAttribute('hidden');
    expect(screen.getByText('Scroll horizontally for more columns')).toHaveAttribute('aria-hidden', 'false');

    Object.defineProperty(viewport, 'scrollLeft', { configurable: true, writable: true, value: 350 });
    fireEvent.scroll(viewport as Element);
    expect(viewport?.parentElement).toHaveAttribute('data-scroll-position', 'middle');
  });
});
