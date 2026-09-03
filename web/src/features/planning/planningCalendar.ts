import type { PlanningEvent } from '@/api/types';
import { zonedDateKey } from './planningDate';
import { addPlanningDays, planningAllDayDateKeys } from './planningTiming';

/** Visual position of an all-day event within its multi-day range. */
export type PlanningAllDaySegment = 'single' | 'start' | 'middle' | 'end';

/** Returns every local calendar date touched by an event. */
export function planningEventDateKeys(event: PlanningEvent, timeZone: string): string[] {
  if (event.allDay) return planningAllDayDateKeys(event.startDate, event.endDateExclusive);
  const first = zonedDateKey(event.startsAt, timeZone);
  const endInstant = event.endsAt ? new Date(event.endsAt).getTime() - 1 : new Date(event.startsAt).getTime();
  const last = zonedDateKey(new Date(Math.max(new Date(event.startsAt).getTime(), endInstant)), timeZone);
  const dates: string[] = [];
  for (let key = first; key <= last; key = addPlanningDays(key, 1)) dates.push(key);
  return dates;
}

/** Places all-day events before timed events, then sorts them chronologically. */
export function comparePlanningEvents(left: PlanningEvent, right: PlanningEvent): number {
  if (left.allDay !== right.allDay) return left.allDay ? -1 : 1;
  return left.startsAt.localeCompare(right.startsAt) || left.title.localeCompare(right.title, 'de');
}

/** Expands event overlaps into independently sorted calendar-day buckets. */
export function groupPlanningEventsByDate(events: readonly PlanningEvent[], timeZone: string): Map<string, PlanningEvent[]> {
  const grouped = new Map<string, PlanningEvent[]>();
  for (const event of events) {
    for (const key of planningEventDateKeys(event, timeZone)) {
      const entries = grouped.get(key) ?? [];
      entries.push(event);
      grouped.set(key, entries);
    }
  }
  for (const entries of grouped.values()) entries.sort(comparePlanningEvents);
  return grouped;
}

/** Returns the subtle month-cell marker segment for one all-day event date. */
export function planningAllDaySegment(event: PlanningEvent, key: string): PlanningAllDaySegment | undefined {
  if (!event.allDay || key < event.startDate || key >= event.endDateExclusive) return undefined;
  const dates = planningAllDayDateKeys(event.startDate, event.endDateExclusive);
  if (dates.length === 1) return 'single';
  if (key === dates[0]) return 'start';
  if (key === dates.at(-1)) return 'end';
  return 'middle';
}
