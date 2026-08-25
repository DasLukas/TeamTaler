import {
  type ColumnDef,
  type OnChangeFn,
  type RowData,
  type SortingState,
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import ArrowDown from 'lucide-react/dist/esm/icons/arrow-down';
import ArrowUp from 'lucide-react/dist/esm/icons/arrow-up';
import ChevronsUpDown from 'lucide-react/dist/esm/icons/chevrons-up-down';
import Filter from 'lucide-react/dist/esm/icons/list-filter';
import MoveHorizontal from 'lucide-react/dist/esm/icons/move-horizontal';
import Search from 'lucide-react/dist/esm/icons/search';
import X from 'lucide-react/dist/esm/icons/x';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput, TextInput } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { MultiSelectMenu } from '@/components/ui/MultiSelectMenu';
import { SelectMenu } from '@/components/ui/SelectMenu';
import { availableDataTableFilterOptions, isDataTableFilterActive, normalizeDataTableFilters } from './dataTableFilters';
import styles from './DataTable.module.css';
import tableStyles from './Table.module.css';

/** Metadata used to label and align TeamTaler data-table columns. */
export interface DataTableColumnMeta {
  /** Accessible column name used by sorting controls. */
  label?: string;
  /** Horizontal alignment applied consistently to header and body cells. */
  align?: 'start' | 'center' | 'end';
}

const dataTableFeatures = tableFeatures({
  columnMeta: {} as DataTableColumnMeta,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
});

const EMPTY_FILTER_DEFINITIONS: readonly DataTableFilterDefinition[] = [];
const EMPTY_FILTERS: DataTableFilterState = {};
const ignoreFilterChange = () => undefined;

/** Inclusive date boundaries represented as ISO calendar dates. */
export interface DataTableDateRange {
  from?: string;
  to?: string;
}

/** Inclusive numeric boundaries used by a number-range filter. */
export interface DataTableNumberRange {
  min?: number;
  max?: number;
}

/** Values supported by the built-in typed filter editors. */
export type DataTableFilterValue = string | string[] | DataTableDateRange | DataTableNumberRange;

/** Controlled filter state keyed by application-defined filter identifiers. */
export type DataTableFilterState<FilterId extends string = string> = Partial<Record<FilterId, DataTableFilterValue>>;

/** A stable value and visible label offered by select filters. */
export interface DataTableFilterOption {
  value: string;
  label: string;
  /** Optional leading product image or semantic category icon. */
  visual?: ReactNode;
  /** Parent option values that make this dependent option available. */
  parentValues?: readonly string[];
}

interface DataTableFilterBase<FilterId extends string> {
  id: FilterId;
  label: string;
  formatValue?: (value: DataTableFilterValue) => string;
}

/** Configuration for a free-text column filter. */
export interface DataTableTextFilter<FilterId extends string = string> extends DataTableFilterBase<FilterId> {
  kind: 'text';
  placeholder?: string;
}

/** Configuration for a single-value select filter. */
export interface DataTableSelectFilter<FilterId extends string = string> extends DataTableFilterBase<FilterId> {
  kind: 'select';
  allLabel: string;
  options: readonly DataTableFilterOption[];
}

/** Configuration for a multiple-value checkbox filter. */
export interface DataTableMultiSelectFilter<FilterId extends string = string> extends DataTableFilterBase<FilterId> {
  kind: 'multi-select';
  allLabel?: string;
  dependsOn?: FilterId;
  dropdown?: boolean;
  emptyLabel?: string;
  noResultsLabel?: string;
  options: readonly DataTableFilterOption[];
  searchLabel?: string;
}

/** Configuration for an inclusive date-range filter. */
export interface DataTableDateRangeFilter<FilterId extends string = string> extends DataTableFilterBase<FilterId> {
  kind: 'date-range';
  fromLabel: string;
  toLabel: string;
}

/** Configuration for an inclusive numeric range filter. */
export interface DataTableNumberRangeFilter<FilterId extends string = string> extends DataTableFilterBase<FilterId> {
  kind: 'number-range';
  minimumLabel: string;
  maximumLabel: string;
  step?: number;
}

/** Discriminated configuration accepted by the built-in filter dialog. */
export type DataTableFilterDefinition<FilterId extends string = string> =
  | DataTableTextFilter<FilterId>
  | DataTableSelectFilter<FilterId>
  | DataTableMultiSelectFilter<FilterId>
  | DataTableDateRangeFilter<FilterId>
  | DataTableNumberRangeFilter<FilterId>;

/** Localized copy required by the reusable data-table controls. */
export interface DataTableLabels {
  applyFilters: string;
  clearFilter: (filterLabel: string) => string;
  clearSearch: string;
  filterButton: string;
  filterHeading: string;
  loadMore: string;
  loading: string;
  loadingMore: string;
  resetFilters: string;
  results: (loadedCount: number, totalCount?: number) => string;
  scrollHint: string;
  searchLabel: string;
  searchPlaceholder: string;
  sortAscending: (columnLabel: string) => string;
  sortDescending: (columnLabel: string) => string;
}

/** Column definition enriched with optional TeamTaler alignment metadata. */
export type DataTableColumnDef<Data extends RowData, Value = unknown> = ColumnDef<typeof dataTableFeatures, Data, Value>;

/** Properties accepted by the reusable data table. */
export interface DataTableProps<Data extends RowData, FilterId extends string = string> {
  ariaLabel: string;
  columns: DataTableColumnDef<Data>[];
  data: Data[];
  emptyContent: ReactNode;
  filterDefinitions?: readonly DataTableFilterDefinition<FilterId>[];
  filters?: DataTableFilterState<FilterId>;
  /** Fills the available block size while keeping only the table viewport scrollable. */
  fillAvailableHeight?: boolean;
  getRowId?: (row: Data, index: number) => string;
  hasMore?: boolean;
  isLoading?: boolean;
  isLoadingMore?: boolean;
  labels: DataTableLabels;
  /** Keeps sorting server-controlled by default; set to false for complete local collections. */
  manualSorting?: boolean;
  minTableWidth?: string;
  onFiltersChange?: (filters: DataTableFilterState<FilterId>) => void;
  onLoadMore?: () => void;
  onSearchChange: (value: string) => void;
  onSortingChange: OnChangeFn<SortingState>;
  searchValue: string;
  sorting: SortingState;
  /** Hides search, filter, and toolbar actions for compact collection tables. */
  showControls?: boolean;
  /** Hides loaded-result feedback when a nearby heading already exposes the collection size. */
  showResultBar?: boolean;
  toolbarActions?: ReactNode;
  totalCount?: number;
}

/** Properties accepted by the horizontal table viewport. */
export interface DataTableViewportProps {
  ariaLabel: string;
  children: ReactNode;
  minTableWidth?: string;
  scrollHint: string;
}

/** Properties accepted by the result and incremental-loading footer. */
export interface DataTableResultBarProps {
  hasMore?: boolean;
  isLoadingMore?: boolean;
  labels: Pick<DataTableLabels, 'loadMore' | 'loadingMore' | 'results'>;
  loadedCount: number;
  onLoadMore?: () => void;
  totalCount?: number;
}

type ScrollPosition = 'none' | 'start' | 'middle' | 'end';

/**
 * Creates an independent copy of controlled filter values for the apply/cancel dialog workflow.
 *
 * @param filters - Currently applied filter values.
 * @returns A shallow value-safe clone whose arrays and range objects can be replaced independently.
 */
function cloneFilters<FilterId extends string>(filters: DataTableFilterState<FilterId>): DataTableFilterState<FilterId> {
  return Object.fromEntries(Object.entries(filters).map(([key, value]) => [
    key,
    Array.isArray(value) ? [...value] : typeof value === 'object' && value !== null ? { ...value } : value,
  ])) as DataTableFilterState<FilterId>;
}

/**
 * Removes inactive values before a draft is applied to server-query state.
 *
 * @param filters - Draft filter state.
 * @returns A state object containing active filters only.
 */
function compactFilters<FilterId extends string>(filters: DataTableFilterState<FilterId>): DataTableFilterState<FilterId> {
  const entries = Object.entries(filters) as [FilterId, DataTableFilterValue | undefined][];
  return Object.fromEntries(entries.filter(([, value]) => isDataTableFilterActive(value))) as DataTableFilterState<FilterId>;
}

/**
 * Renders a focusable horizontal viewport with edge shadows and a mobile scroll cue.
 *
 * @param props - Accessible name, table content, minimum width, and localized scroll hint.
 * @returns A horizontal table region whose current edge state is visually exposed.
 *
 * @example
 * <DataTableViewport ariaLabel="Payments" scrollHint="Scroll horizontally" minTableWidth="760px"><table /></DataTableViewport>
 */
export function DataTableViewport({ ariaLabel, children, minTableWidth = '720px', scrollHint }: DataTableViewportProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollPosition, setScrollPosition] = useState<ScrollPosition>('none');

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;

    const updateScrollPosition = () => {
      const maximumScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      if (maximumScrollLeft <= 1) {
        setScrollPosition('none');
      } else if (viewport.scrollLeft <= 1) {
        setScrollPosition('start');
      } else if (viewport.scrollLeft >= maximumScrollLeft - 1) {
        setScrollPosition('end');
      } else {
        setScrollPosition('middle');
      }
    };

    updateScrollPosition();
    viewport.addEventListener('scroll', updateScrollPosition, { passive: true });
    window.addEventListener('resize', updateScrollPosition);
    const resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(updateScrollPosition);
    resizeObserver?.observe(viewport);
    if (viewport.firstElementChild) resizeObserver?.observe(viewport.firstElementChild);
    return () => {
      viewport.removeEventListener('scroll', updateScrollPosition);
      window.removeEventListener('resize', updateScrollPosition);
      resizeObserver?.disconnect();
    };
  }, []);

  return (
    <div className={styles.viewportShell}>
      <div className={styles.viewportFrame} data-scroll-position={scrollPosition}>
        <div
          aria-label={ariaLabel}
          className={`${tableStyles.tableWrap} ${styles.viewport}`}
          ref={viewportRef}
          role="region"
          style={{ '--data-table-min-width': minTableWidth } as CSSProperties}
          tabIndex={scrollPosition === 'none' ? undefined : 0}
        >
          {children}
        </div>
      </div>
      <p aria-hidden={scrollPosition === 'none'} className={styles.scrollHint} hidden={scrollPosition === 'none'}>
        <MoveHorizontal aria-hidden="true" size={16} />
        {scrollHint}
      </p>
    </div>
  );
}

/**
 * Renders loaded/total result feedback and an optional incremental-loading action.
 *
 * @param props - Counts, loading state, localized labels, and load callback.
 * @returns A polite result status with an optional load-more button.
 */
export function DataTableResultBar({ hasMore = false, isLoadingMore = false, labels, loadedCount, onLoadMore, totalCount }: DataTableResultBarProps) {
  return (
    <footer className={styles.resultBar}>
      <span aria-live="polite" role="status">{labels.results(loadedCount, totalCount)}</span>
      {hasMore && onLoadMore ? (
        <Button
          disabled={isLoadingMore}
          leadingIcon={isLoadingMore ? <span className={styles.loadingDot} /> : <ArrowDown size={17} />}
          onClick={onLoadMore}
          size="small"
          variant="secondary"
        >
          {isLoadingMore ? labels.loadingMore : labels.loadMore}
        </Button>
      ) : null}
    </footer>
  );
}

interface FilterEditorProps<FilterId extends string> {
  definition: DataTableFilterDefinition<FilterId>;
  filters: DataTableFilterState<FilterId>;
  onChange: (value: DataTableFilterValue | undefined) => void;
  value: DataTableFilterValue | undefined;
}

/** Renders the editor matching one discriminated filter definition. */
function FilterEditor<FilterId extends string>({ definition, filters, onChange, value }: FilterEditorProps<FilterId>) {
  const controlId = useId();

  if (definition.kind === 'text') {
    return (
      <Field htmlFor={controlId} label={definition.label}>
        <TextInput
          id={controlId}
          onChange={(event) => onChange(event.target.value)}
          placeholder={definition.placeholder}
          type="text"
          value={typeof value === 'string' ? value : ''}
        />
      </Field>
    );
  }

  if (definition.kind === 'select') {
    if (definition.options.some((option) => option.visual)) {
      const options = [{ label: definition.allLabel, value: '' }, ...definition.options];
      return (
        <Field htmlFor={controlId} label={definition.label}>
          <SelectMenu
            ariaLabel={definition.label}
            id={controlId}
            onChange={(nextValue) => onChange(nextValue || undefined)}
            options={options}
            value={typeof value === 'string' ? value : ''}
          />
        </Field>
      );
    }
    return (
      <Field htmlFor={controlId} label={definition.label}>
        <SelectInput id={controlId} onChange={(event) => onChange(event.target.value || undefined)} value={typeof value === 'string' ? value : ''}>
          <option value="">{definition.allLabel}</option>
          {definition.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </SelectInput>
      </Field>
    );
  }

  if (definition.kind === 'multi-select') {
    const selectedValues = Array.isArray(value) ? value : [];
    const availableOptions = availableDataTableFilterOptions(definition, filters);
    if (definition.dropdown) {
      return (
        <Field htmlFor={controlId} label={definition.label}>
          <MultiSelectMenu
            allLabel={definition.allLabel ?? '—'}
            emptyLabel={definition.emptyLabel ?? '—'}
            id={controlId}
            label={definition.label}
            noResultsLabel={definition.noResultsLabel}
            onChange={(nextValues) => onChange(nextValues.length > 0 ? nextValues : undefined)}
            options={availableOptions}
            searchLabel={definition.searchLabel}
            values={selectedValues}
          />
        </Field>
      );
    }
    return (
      <fieldset className={styles.checkboxGroup}>
        <legend>{definition.label}</legend>
        {availableOptions.map((option) => (
          <label key={option.value}>
            <input
              checked={selectedValues.includes(option.value)}
              onChange={(event) => {
                const nextValues = event.target.checked
                  ? [...selectedValues, option.value]
                  : selectedValues.filter((selectedValue) => selectedValue !== option.value);
                onChange(nextValues.length > 0 ? nextValues : undefined);
              }}
              type="checkbox"
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>
    );
  }

  if (definition.kind === 'date-range') {
    const range = !Array.isArray(value) && typeof value === 'object' && value !== null ? value as DataTableDateRange : {};
    return (
      <fieldset className={styles.rangeGroup}>
        <legend>{definition.label}</legend>
        <Field htmlFor={`${controlId}-from`} label={definition.fromLabel}>
          <TextInput id={`${controlId}-from`} onChange={(event) => onChange({ ...range, from: event.target.value || undefined })} type="date" value={range.from ?? ''} />
        </Field>
        <Field htmlFor={`${controlId}-to`} label={definition.toLabel}>
          <TextInput id={`${controlId}-to`} onChange={(event) => onChange({ ...range, to: event.target.value || undefined })} type="date" value={range.to ?? ''} />
        </Field>
      </fieldset>
    );
  }

  const range = !Array.isArray(value) && typeof value === 'object' && value !== null ? value as DataTableNumberRange : {};
  return (
    <fieldset className={styles.rangeGroup}>
      <legend>{definition.label}</legend>
      <Field htmlFor={`${controlId}-minimum`} label={definition.minimumLabel}>
        <TextInput
          id={`${controlId}-minimum`}
          inputMode="decimal"
          onChange={(event) => {
            const minimum = event.target.valueAsNumber;
            onChange({ ...range, min: event.target.value === '' || !Number.isFinite(minimum) ? undefined : minimum });
          }}
          step={definition.step}
          type="number"
          value={range.min ?? ''}
        />
      </Field>
      <Field htmlFor={`${controlId}-maximum`} label={definition.maximumLabel}>
        <TextInput
          id={`${controlId}-maximum`}
          inputMode="decimal"
          onChange={(event) => {
            const maximum = event.target.valueAsNumber;
            onChange({ ...range, max: event.target.value === '' || !Number.isFinite(maximum) ? undefined : maximum });
          }}
          step={definition.step}
          type="number"
          value={range.max ?? ''}
        />
      </Field>
    </fieldset>
  );
}

/** Formats a filter value for its removable active-filter chip. */
function formatFilterValue<FilterId extends string>(definition: DataTableFilterDefinition<FilterId>, value: DataTableFilterValue): string {
  if (definition.formatValue) return definition.formatValue(value);
  if (definition.kind === 'select' && typeof value === 'string') {
    return definition.options.find((option) => option.value === value)?.label ?? value;
  }
  if (definition.kind === 'multi-select' && Array.isArray(value)) {
    const labelsByValue = new Map(definition.options.map((option) => [option.value, option.label]));
    return value.map((item) => labelsByValue.get(item) ?? item).join(', ');
  }
  if (definition.kind === 'date-range' && !Array.isArray(value) && typeof value === 'object') {
    const range = value as DataTableDateRange;
    return [range.from && `${definition.fromLabel}: ${range.from}`, range.to && `${definition.toLabel}: ${range.to}`].filter(Boolean).join(' · ');
  }
  if (definition.kind === 'number-range' && !Array.isArray(value) && typeof value === 'object') {
    const range = value as DataTableNumberRange;
    return [range.min !== undefined && `${definition.minimumLabel}: ${range.min}`, range.max !== undefined && `${definition.maximumLabel}: ${range.max}`].filter(Boolean).join(' · ');
  }
  return String(value);
}

interface DataTableControlsProps<FilterId extends string> {
  definitions: readonly DataTableFilterDefinition<FilterId>[];
  filters: DataTableFilterState<FilterId>;
  labels: DataTableLabels;
  onFiltersChange: (filters: DataTableFilterState<FilterId>) => void;
  onSearchChange: (value: string) => void;
  searchValue: string;
  toolbarActions?: ReactNode;
}

/** Renders global search, staged typed filters, and active-filter chips. */
function DataTableControls<FilterId extends string>({ definitions, filters, labels, onFiltersChange, onSearchChange, searchValue, toolbarActions }: DataTableControlsProps<FilterId>) {
  const filterFormId = useId();
  const [filterDialogOpen, setFilterDialogOpen] = useState(false);
  const [draftFilters, setDraftFilters] = useState<DataTableFilterState<FilterId>>(() => cloneFilters(filters));
  const activeDefinitions = definitions.filter((definition) => isDataTableFilterActive(filters[definition.id]));

  const openFilterDialog = () => {
    setDraftFilters(cloneFilters(filters));
    setFilterDialogOpen(true);
  };
  const removeFilter = (filterId: FilterId) => {
    const nextFilters = { ...filters };
    delete nextFilters[filterId];
    onFiltersChange(nextFilters);
  };

  return (
    <div className={styles.controls}>
      <div className={styles.toolbar}>
        <label className={styles.searchField}>
          <span className={styles.visuallyHidden}>{labels.searchLabel}</span>
          <Search aria-hidden="true" size={19} />
          <input
            aria-label={labels.searchLabel}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={labels.searchPlaceholder}
            type="search"
            value={searchValue}
          />
          {searchValue ? (
            <button aria-label={labels.clearSearch} className={styles.clearSearch} onClick={() => onSearchChange('')} type="button">
              <X aria-hidden="true" size={17} />
            </button>
          ) : null}
        </label>
        <div className={styles.toolbarButtons}>
          {definitions.length > 0 ? (
            <Button
              aria-expanded={filterDialogOpen}
              aria-haspopup="dialog"
              leadingIcon={<Filter size={18} />}
              onClick={openFilterDialog}
              variant="secondary"
            >
              {labels.filterButton}
              {activeDefinitions.length > 0 ? <span aria-hidden="true" className={styles.filterCount}>{activeDefinitions.length}</span> : null}
              {activeDefinitions.length > 0 ? <span className={styles.visuallyHidden}> ({activeDefinitions.length})</span> : null}
            </Button>
          ) : null}
          {toolbarActions}
        </div>
      </div>
      {activeDefinitions.length > 0 ? (
        <div aria-label={labels.filterHeading} className={styles.filterChips} role="list">
          {activeDefinitions.map((definition) => {
            const value = filters[definition.id];
            if (!value) return null;
            return (
              <span className={styles.filterChip} key={definition.id} role="listitem">
                <span><strong>{definition.label}:</strong> {formatFilterValue(definition, value)}</span>
                <button aria-label={labels.clearFilter(definition.label)} onClick={() => removeFilter(definition.id)} type="button"><X aria-hidden="true" size={15} /></button>
              </span>
            );
          })}
          <button className={styles.resetLink} onClick={() => onFiltersChange({})} type="button">{labels.resetFilters}</button>
        </div>
      ) : null}
      <Modal
        footer={(
          <div className={styles.filterActions}>
            <Button leadingIcon={<X size={17} />} onClick={() => setDraftFilters({})} variant="secondary">{labels.resetFilters}</Button>
            <Button form={filterFormId} leadingIcon={<Filter size={17} />} type="submit">{labels.applyFilters}</Button>
          </div>
        )}
        onClose={() => setFilterDialogOpen(false)}
        open={filterDialogOpen}
        title={labels.filterHeading}
        variant="sheet"
      >
        <form
          className={styles.filterForm}
          id={filterFormId}
          onSubmit={(event) => {
            event.preventDefault();
            onFiltersChange(compactFilters(normalizeDataTableFilters(draftFilters, definitions)));
            setFilterDialogOpen(false);
          }}
        >
          <div className={styles.filterFields}>
            {definitions.map((definition) => (
              <FilterEditor
                definition={definition}
                filters={draftFilters}
                key={definition.id}
                onChange={(value) => setDraftFilters((current) => normalizeDataTableFilters({ ...current, [definition.id]: value }, definitions))}
                value={draftFilters[definition.id]}
              />
            ))}
          </div>
        </form>
      </Modal>
    </div>
  );
}

/**
 * Renders a reusable manual-mode data table for server-side search, filtering, sorting, and cursor loading.
 *
 * @param props - Controlled query state, TanStack column definitions, row data, localized copy, and optional load-more state.
 * @returns Accessible table controls, a horizontally scrollable semantic table, and result feedback.
 *
 * @example
 * <DataTable ariaLabel="Payments" columns={columns} data={payments} emptyContent="No payments" labels={labels} onSearchChange={setSearch} onSortingChange={setSorting} searchValue={search} sorting={sorting} />
 */
export function DataTable<Data extends RowData, FilterId extends string = string>({
  ariaLabel,
  columns,
  data,
  emptyContent,
  filterDefinitions,
  filters,
  fillAvailableHeight = false,
  getRowId,
  hasMore = false,
  isLoading = false,
  isLoadingMore = false,
  labels,
  manualSorting = true,
  minTableWidth,
  onFiltersChange,
  onLoadMore,
  onSearchChange,
  onSortingChange,
  searchValue,
  showControls = true,
  showResultBar = true,
  sorting,
  toolbarActions,
  totalCount,
}: DataTableProps<Data, FilterId>) {
  const resolvedFilterDefinitions = filterDefinitions ?? EMPTY_FILTER_DEFINITIONS as readonly DataTableFilterDefinition<FilterId>[];
  const resolvedFilters = filters ?? EMPTY_FILTERS as DataTableFilterState<FilterId>;
  const table = useTable({
    features: dataTableFeatures,
    columns,
    data,
    enableMultiSort: false,
    getRowId,
    manualSorting,
    onSortingChange,
    state: { sorting },
  });

  return (
    <div className={`${styles.root} ${fillAvailableHeight ? styles.fillAvailableHeight : ''}`}>
      {showControls ? <DataTableControls
        definitions={resolvedFilterDefinitions}
        filters={resolvedFilters}
        labels={labels}
        onFiltersChange={onFiltersChange ?? ignoreFilterChange}
        onSearchChange={onSearchChange}
        searchValue={searchValue}
        toolbarActions={toolbarActions}
      /> : null}
      <DataTableViewport ariaLabel={ariaLabel} minTableWidth={minTableWidth} scrollHint={labels.scrollHint}>
        <table aria-label={ariaLabel} className={`${tableStyles.table} ${styles.dataTable}`}>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  const sortable = header.column.getCanSort();
                  const label = header.column.columnDef.meta?.label ?? header.column.id;
                  const alignment = header.column.columnDef.meta?.align ?? 'start';
                  const nextSortLabel = sorted === 'asc' ? labels.sortDescending(label) : labels.sortAscending(label);
                  return (
                    <th
                      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                      className={styles[alignment]}
                      key={header.id}
                      scope="col"
                    >
                      {header.isPlaceholder ? null : sortable ? (
                        <button aria-label={nextSortLabel} className={styles.sortButton} onClick={header.column.getToggleSortingHandler()} type="button">
                          <span><table.FlexRender header={header} /></span>
                          {sorted === 'asc' ? <ArrowUp aria-hidden="true" size={15} /> : sorted === 'desc' ? <ArrowDown aria-hidden="true" size={15} /> : <ChevronsUpDown aria-hidden="true" size={15} />}
                        </button>
                      ) : <table.FlexRender header={header} />}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {isLoading && data.length === 0 ? (
              <tr><td className={styles.tableState} colSpan={Math.max(1, columns.length)} role="status">{labels.loading}</td></tr>
            ) : table.getRowModel().rows.length === 0 ? (
              <tr><td className={styles.tableState} colSpan={Math.max(1, columns.length)}>{emptyContent}</td></tr>
            ) : table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getAllCells().map((cell) => (
                  <td className={styles[cell.column.columnDef.meta?.align ?? 'start']} key={cell.id}>
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </DataTableViewport>
      {showResultBar ? <DataTableResultBar
        hasMore={hasMore}
        isLoadingMore={isLoadingMore}
        labels={labels}
        loadedCount={data.length}
        onLoadMore={onLoadMore}
        totalCount={totalCount}
      /> : null}
    </div>
  );
}
