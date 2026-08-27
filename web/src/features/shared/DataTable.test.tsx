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
type DependentFilterId = 'categoryId' | 'productId';

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
      { label: 'Open', value: 'open', visual: <span data-testid="open-visual">O</span> },
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

const dependentFilterDefinitions: readonly DataTableFilterDefinition<DependentFilterId>[] = [
  {
    allLabel: 'All categories',
    dropdown: true,
    emptyLabel: 'No categories',
    id: 'categoryId',
    kind: 'multi-select',
    label: 'Category',
    noResultsLabel: 'No matching categories',
    options: [
      { label: 'Drinks', value: 'drinks', visual: <span data-testid="drinks-visual">D</span> },
      { label: 'Snacks', value: 'snacks', visual: <span data-testid="snacks-visual">S</span> },
    ],
    searchLabel: 'Search categories',
  },
  {
    allLabel: 'All products',
    dependsOn: 'categoryId',
    dropdown: true,
    emptyLabel: 'No matching products',
    id: 'productId',
    kind: 'multi-select',
    label: 'Product',
    noResultsLabel: 'No matching products',
    options: [
      { label: 'Water', parentValues: ['drinks'], value: 'water', visual: <span data-testid="water-visual">W</span> },
      { label: 'Pretzel', parentValues: ['snacks'], value: 'pretzel', visual: <span data-testid="pretzel-visual">P</span> },
    ],
    searchLabel: 'Search products',
  },
];

/** Supplies dependent dropdown filters so invalid child selections can be tested. */
function ControlledDependentTable() {
  const [filters, setFilters] = useState<DataTableFilterState<DependentFilterId>>({});
  const [sorting, setSorting] = useState<SortingState>([]);
  return (
    <DataTable
      ariaLabel="Products"
      columns={columns}
      data={rows}
      emptyContent="No products"
      filterDefinitions={dependentFilterDefinitions}
      filters={filters}
      labels={labels}
      onFiltersChange={setFilters}
      onSearchChange={() => undefined}
      onSortingChange={setSorting}
      searchValue=""
      sorting={sorting}
    />
  );
}

/** Supplies a complete local collection without search, filters, or result feedback. */
function CompactClientTable() {
  const [sorting, setSorting] = useState<SortingState>([]);
  return (
    <DataTable
      ariaLabel="Members"
      columns={columns}
      data={[rows[1], rows[0]]}
      emptyContent="No members"
      labels={labels}
      manualSorting={false}
      onSearchChange={() => undefined}
      onSortingChange={setSorting}
      searchValue=""
      showControls={false}
      showResultBar={false}
      sorting={sorting}
    />
  );
}

/** Supplies a locally sorted card presentation through the shared collection shell. */
function CardClientTable() {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'name', desc: false }]);
  return (
    <DataTable
      ariaLabel="Members table"
      cardView={{ ariaLabel: 'Members cards', renderItem: (row) => <article>{row.name}</article> }}
      columns={columns}
      data={[rows[1], rows[0]]}
      emptyContent="No members"
      labels={labels}
      manualSorting={false}
      onSearchChange={() => undefined}
      onSortingChange={setSorting}
      searchValue=""
      showControls={false}
      sorting={sorting}
      viewMode="cards"
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
    await user.click(within(dialog).getByRole('combobox', { name: 'Status' }));
    const statusMenu = screen.getByRole('listbox', { name: 'Status' });
    expect(within(statusMenu).getByTestId('open-visual')).toBeVisible();
    await user.click(within(statusMenu).getByRole('option', { name: 'Open' }));
    fireEvent.change(within(dialog).getByLabelText('From'), { target: { value: '2026-08-01' } });

    expect(screen.getByRole('button', { name: 'Filters' })).toHaveAccessibleName('Filters');
    const applyButton = within(dialog).getByRole('button', { name: 'Apply filters' });
    const filterForm = dialog.querySelector('form');
    expect(applyButton.closest('footer')).not.toBeNull();
    expect(applyButton).toHaveAttribute('form', filterForm?.id);
    await user.click(applyButton);

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

  it('sorts complete local collections without rendering query controls or result feedback', async () => {
    const user = userEvent.setup();
    render(<CompactClientTable />);

    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Members' });
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Grace');

    await user.click(screen.getByRole('button', { name: 'Sort Name ascending' }));
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Ada');
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'ascending');
  });

  it('renders optional cards from the same sorted row model while preserving result feedback', () => {
    render(<CardClientTable />);

    expect(screen.queryByRole('table', { name: 'Members table' })).not.toBeInTheDocument();
    const cardRegion = screen.getByRole('region', { name: 'Members cards' });
    const cards = within(cardRegion).getAllByRole('article');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent('Ada');
    expect(screen.getByRole('status')).toHaveTextContent('2 results');
  });

  it('renders visual custom multi-selects and removes products outside selected categories', async () => {
    const user = userEvent.setup();
    render(<ControlledDependentTable />);

    await user.click(screen.getByRole('button', { name: 'Filters' }));
    const filterDialog = screen.getByRole('dialog', { name: 'Filter results' });
    const categoryTrigger = within(filterDialog).getByRole('button', { name: 'Category' });
    const productTrigger = within(filterDialog).getByRole('button', { name: 'Product' });

    await user.click(categoryTrigger);
    const categoryMenu = screen.getByRole('dialog', { name: 'Category' });
    expect(within(categoryMenu).getByTestId('drinks-visual')).toBeVisible();
    await user.type(within(categoryMenu).getByRole('searchbox', { name: 'Search categories' }), 'drink');
    expect(within(categoryMenu).queryByRole('checkbox', { name: 'Snacks' })).not.toBeInTheDocument();
    fireEvent.scroll(categoryMenu);
    expect(within(categoryMenu).getByRole('searchbox', { name: 'Search categories' })).toBeVisible();
    await user.click(within(categoryMenu).getByRole('checkbox', { name: 'Drinks' }));

    await user.click(productTrigger);
    const productMenu = screen.getByRole('dialog', { name: 'Product' });
    expect(within(productMenu).getByRole('checkbox', { name: 'Water' })).toBeVisible();
    expect(within(productMenu).queryByRole('checkbox', { name: 'Pretzel' })).not.toBeInTheDocument();
    await user.click(within(productMenu).getByRole('checkbox', { name: 'Water' }));

    await user.click(categoryTrigger);
    await user.click(within(screen.getByRole('dialog', { name: 'Category' })).getByRole('checkbox', { name: 'Drinks' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Category' })).getByRole('checkbox', { name: 'Snacks' }));
    await user.click(productTrigger);

    const restrictedProductMenu = screen.getByRole('dialog', { name: 'Product' });
    expect(within(restrictedProductMenu).getByRole('checkbox', { name: 'Pretzel' })).toBeVisible();
    expect(within(restrictedProductMenu).queryByRole('checkbox', { name: 'Water' })).not.toBeInTheDocument();
    await user.click(within(filterDialog).getByRole('button', { name: 'Apply filters' }));
    expect(screen.getByRole('list', { name: 'Filter results' })).toHaveTextContent('Category: Snacks');
    expect(screen.getByRole('list', { name: 'Filter results' })).not.toHaveTextContent('Product:');
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
