import { zonedStartOfDay } from './planningDate';
import type { PlanningView } from './planningSearch';
import { addPlanningDays, isPlanningDateKey } from './planningTiming';

const DAY_MONTH_SPACE = /(\d{1,2}\.) (?=\p{L})/gu;

/** Canonical event-query interval and visible date keys for one calendar view. */
export interface PlanningVisibleRange {
  dateKeys: string[];
  from: string;
  fromDate: string;
  to: string;
  toDateExclusive: string;
}

function dateValue(key: string): Date {
  return new Date(`${key}T12:00:00Z`);
}

function monthStart(key: string): string {
  return `${key.slice(0, 7)}-01`;
}

function bindDayToMonth(label: string): string {
  return label.replace(DAY_MONTH_SPACE, '$1\u00a0');
}

/** Returns the Monday anchoring the ISO-style week containing a date. */
export function planningWeekStart(key: string): string {
  if (!isPlanningDateKey(key)) throw new RangeError('A valid planning date is required.');
  const day = dateValue(key).getUTCDay();
  return addPlanningDays(key, -((day + 6) % 7));
}

/** Returns the complete Monday-first six-week month grid as date keys. */
export function planningMonthDateKeys(key: string): string[] {
  const first = monthStart(key);
  const start = planningWeekStart(first);
  return Array.from({ length: 42 }, (_, index) => addPlanningDays(start, index));
}

/** Returns the date keys rendered by one planning view. */
export function planningViewDateKeys(view: PlanningView, anchor: string): string[] {
  if (!isPlanningDateKey(anchor)) throw new RangeError('A valid planning date is required.');
  if (view === 'day') return [anchor];
  if (view === 'week') {
    const start = planningWeekStart(anchor);
    return Array.from({ length: 7 }, (_, index) => addPlanningDays(start, index));
  }
  if (view === 'month') return planningMonthDateKeys(anchor);
  return Array.from({ length: 90 }, (_, index) => addPlanningDays(anchor, index));
}

/** Builds the exact group-zone interval requested from the planning API. */
export function planningVisibleRange(view: PlanningView, anchor: string, timeZone: string): PlanningVisibleRange {
  const dateKeys = planningViewDateKeys(view, anchor);
  const endKey = addPlanningDays(dateKeys.at(-1) ?? anchor, 1);
  return {
    dateKeys,
    from: zonedStartOfDay(dateKeys[0] ?? anchor, timeZone).toISOString(),
    fromDate: dateKeys[0] ?? anchor,
    to: zonedStartOfDay(endKey, timeZone).toISOString(),
    toDateExclusive: endKey,
  };
}

function moveMonth(anchor: string, offset: number): string {
  const source = dateValue(anchor);
  const targetFirst = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + offset, 1));
  const targetLastDay = new Date(Date.UTC(targetFirst.getUTCFullYear(), targetFirst.getUTCMonth() + 1, 0)).getUTCDate();
  targetFirst.setUTCDate(Math.min(source.getUTCDate(), targetLastDay));
  return targetFirst.toISOString().slice(0, 10);
}

/** Moves the anchor by one complete period for the active view. */
export function movePlanningViewAnchor(view: PlanningView, anchor: string, offset: -1 | 1): string {
  if (view === 'day') return addPlanningDays(anchor, offset);
  if (view === 'week') return addPlanningDays(anchor, offset * 7);
  if (view === 'month') return moveMonth(anchor, offset);
  return addPlanningDays(anchor, offset * 90);
}

/** Formats the localized period heading shown by the planning toolbar. */
export function formatPlanningViewLabel(view: PlanningView, anchor: string): string {
  const date = dateValue(anchor);
  if (view === 'day') return bindDayToMonth(new Intl.DateTimeFormat('de-DE', { dateStyle: 'full', timeZone: 'UTC' }).format(date));
  if (view === 'month') return new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
  const keys = planningViewDateKeys(view, anchor);
  const formatter = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return bindDayToMonth(formatter.formatRange(dateValue(keys[0] ?? anchor), dateValue(keys.at(-1) ?? anchor)));
}
