import type { PlanningEvent } from '@/api/types';
import { formatPlanningDateTime } from './planningDate';

/** Validates a strict Gregorian calendar date without applying a time zone. */
export function isPlanningDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

/** Adds complete calendar days to a strict date key without DST drift. */
export function addPlanningDays(key: string, days: number): string {
  if (!isPlanningDateKey(key)) throw new RangeError('A valid planning date is required.');
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Converts the inclusive date used by the form to the API's exclusive end date. */
export function planningEndDateExclusive(endDate: string): string {
  return addPlanningDays(endDate, 1);
}

/** Converts an API-exclusive all-day end to the inclusive date shown in the form. */
export function planningEndDateInclusive(endDateExclusive: string): string {
  return addPlanningDays(endDateExclusive, -1);
}

/** Checks a complete inclusive all-day range entered by a user. */
export function planningAllDayRangeIsValid(startDate: string, endDate: string): boolean {
  return isPlanningDateKey(startDate) && isPlanningDateKey(endDate) && endDate >= startDate;
}

/** Enumerates every date touched by an exclusive all-day range. */
export function planningAllDayDateKeys(startDate: string, endDateExclusive: string): string[] {
  if (!isPlanningDateKey(startDate) || !isPlanningDateKey(endDateExclusive) || endDateExclusive <= startDate) return [];
  const dates: string[] = [];
  for (let key = startDate; key < endDateExclusive; key = addPlanningDays(key, 1)) dates.push(key);
  return dates;
}

function dateOnlyValue(key: string): Date {
  return new Date(`${key}T12:00:00Z`);
}

/** Formats an all-day range using an inclusive user-facing end date. */
export function formatPlanningAllDayRange(startDate: string, endDateExclusive: string): string {
  const endDate = planningEndDateInclusive(endDateExclusive);
  const formatter = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeZone: 'UTC' });
  const start = formatter.format(dateOnlyValue(startDate));
  return startDate === endDate ? start : `${start}–${formatter.format(dateOnlyValue(endDate))}`;
}

/** Formats one event for compact dashboard and detail schedule summaries. */
export function formatPlanningEventSchedule(event: PlanningEvent, timeZone: string, allDayLabel: string): string {
  return event.allDay
    ? `${formatPlanningAllDayRange(event.startDate, event.endDateExclusive)} · ${allDayLabel}`
    : formatPlanningDateTime(event.startsAt, timeZone);
}

/** Formats the time column used by calendar agendas without fake midnight values. */
export function formatPlanningEventTime(event: PlanningEvent, timeZone: string, allDayLabel: string): string {
  if (event.allDay) return allDayLabel;
  const formatter = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone });
  return event.endsAt
    ? `${formatter.format(new Date(event.startsAt))}–${formatter.format(new Date(event.endsAt))}`
    : formatter.format(new Date(event.startsAt));
}

/** Derives inclusive all-day dates from remembered local timed form values. */
export function planningAllDayRangeFromTimed(startsAt: string, endsAt: string): { startDate: string; endDate: string } {
  const startDate = isPlanningDateKey(startsAt.slice(0, 10)) ? startsAt.slice(0, 10) : '';
  let endDate = isPlanningDateKey(endsAt.slice(0, 10)) ? endsAt.slice(0, 10) : startDate;
  if (endsAt.endsWith('T00:00') && endDate > startDate) endDate = addPlanningDays(endDate, -1);
  if (endDate < startDate) endDate = startDate;
  return { startDate, endDate };
}

/** Reapplies remembered wall-clock times to the currently selected all-day dates. */
export function planningTimedRangeFromAllDay(startDate: string, endDate: string, startsAt: string, endsAt: string): { startsAt: string; endsAt: string } {
  const rememberedDates = planningAllDayRangeFromTimed(startsAt, endsAt);
  if (rememberedDates.startDate === startDate && rememberedDates.endDate === endDate) return { startsAt, endsAt };
  const startTime = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})$/.exec(startsAt)?.[1] ?? '09:00';
  const endTime = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})$/.exec(endsAt)?.[1] ?? '10:00';
  return { startsAt: `${startDate}T${startTime}`, endsAt: `${endDate}T${endTime}` };
}
