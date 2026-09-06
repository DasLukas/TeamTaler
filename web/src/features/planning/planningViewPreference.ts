import { isPlanningView, type PlanningView } from './planningSearch';

/** Versioned browser key storing the last explicitly selected planning view. */
export const PLANNING_VIEW_STORAGE_KEY = 'teamtaler:planning-view:v1';

interface StoredPlanningView {
  version: 1;
  view: PlanningView;
}

/**
 * Reads a validated global planning-view preference.
 *
 * @param storage - Optional storage implementation used by tests or non-browser callers.
 * @returns The last explicitly selected view, or `undefined` for unavailable or invalid data.
 */
export function readPlanningViewPreference(storage?: Pick<Storage, 'getItem'>): PlanningView | undefined {
  try {
    const target = storage ?? globalThis.window?.localStorage;
    if (!target) return undefined;
    const raw = target.getItem(PLANNING_VIEW_STORAGE_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<StoredPlanningView>;
    return value.version === 1 && isPlanningView(value.view) ? value.view : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persists one explicit planning-view selection without making storage mandatory.
 *
 * @param view - View selected through the planning toolbar.
 * @param storage - Optional storage implementation used by tests or non-browser callers.
 */
export function writePlanningViewPreference(view: PlanningView, storage?: Pick<Storage, 'setItem'>): void {
  try {
    const target = storage ?? globalThis.window?.localStorage;
    if (!target) return;
    target.setItem(PLANNING_VIEW_STORAGE_KEY, JSON.stringify({ version: 1, view } satisfies StoredPlanningView));
  } catch {
    // URL state remains authoritative when browser privacy settings block storage.
  }
}
