/** Supported planning-calendar representations. */
export type PlanningView = 'day' | 'week' | 'month' | 'agenda';

/** URL state shared by the planning calendar and contextual child screens. */
export interface PlanningSearch {
  date?: string;
  time?: string;
  view?: PlanningView;
}

/** Reports whether an unknown value is a real ISO calendar date. */
export function isPlanningDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

/** Reports whether an unknown value is a strict 24-hour wall-clock time. */
export function isPlanningTime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** Reports whether an unknown value is a supported planning view. */
export function isPlanningView(value: unknown): value is PlanningView {
  return value === 'day' || value === 'week' || value === 'month' || value === 'agenda';
}

/** Validates planning navigation state without retaining unrelated parameters. */
export function validatePlanningSearch(search: Record<string, unknown>): PlanningSearch {
  return {
    date: isPlanningDate(search.date) ? search.date : undefined,
    time: isPlanningTime(search.time) ? search.time : undefined,
    view: isPlanningView(search.view) ? search.view : undefined,
  };
}

/** Removes create-only values while retaining shareable calendar context. */
export function planningContextSearch(search: PlanningSearch): PlanningSearch {
  return { date: search.date, view: search.view };
}
