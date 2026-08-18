import type { DataTableFilterValue } from './DataTable';

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
