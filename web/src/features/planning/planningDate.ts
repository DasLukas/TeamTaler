/** Returns the local calendar date used by planning URL state. */
export function dateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Parses a strict calendar-date key and safely falls back to today. */
export function parseDateKey(value: unknown): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date();
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  return dateKey(parsed) === value ? parsed : new Date();
}

/** Builds the complete Monday-first grid for a local calendar month. */
export function monthGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - mondayOffset);
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
}

/** Formats a date-time with the active German product locale. */
export function formatPlanningDateTime(value: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(value));
}

/** Formats a time range without repeating the date. */
export function formatPlanningTimeRange(startsAt: string, endsAt?: string, timeZone?: string): string {
  const formatter = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone });
  return endsAt ? `${formatter.format(new Date(startsAt))}–${formatter.format(new Date(endsAt))}` : formatter.format(new Date(startsAt));
}

/** Returns the calendar key of an instant in a named IANA time zone. */
export function zonedDateKey(value: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Converts midnight in a named time zone to its UTC instant, including DST boundaries. */
export function zonedStartOfDay(key: string, timeZone: string): Date {
  return new Date(zonedDateTimeInputToIso(`${key}T00:00`, timeZone));
}

function zoneOffsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  return Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second')) - instant;
}

/** Converts one group-zone wall-clock input to a canonical UTC timestamp. */
export function zonedDateTimeInputToIso(value: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new RangeError('A valid local date-time is required.');
  const [, year, month, day, hour, minute] = match.map(Number);
  const wallClockUtc = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wallClockUtc - zoneOffsetAt(wallClockUtc, timeZone);
  instant = wallClockUtc - zoneOffsetAt(instant, timeZone);
  const result = new Date(instant).toISOString();
  if (toZonedDateTimeInput(result, timeZone) !== value) throw new RangeError('The local date-time does not exist in this time zone.');
  return result;
}

/**
 * Enumerates distinct instants represented by one group-zone wall-clock value.
 *
 * A normal value has one occurrence, a spring-forward gap throws through the
 * canonical converter, and an autumn fold returns multiple offsets. The
 * bounded offset probes cover modern IANA transitions without scanning a day.
 */
export function zonedDateTimeInputOccurrences(value: string, timeZone: string): string[] {
  const primary = zonedDateTimeInputToIso(value, timeZone);
  const primaryTime = new Date(primary).getTime();
  const instants = new Set([primary]);
  for (const minutes of [-120, -90, -60, -30, 30, 60, 90, 120]) {
    const candidate = new Date(primaryTime + minutes * 60_000).toISOString();
    if (toZonedDateTimeInput(candidate, timeZone) === value) instants.add(candidate);
  }
  return [...instants].sort();
}

/** Converts an instant to a datetime-local value in the named group zone. */
export function toZonedDateTimeInput(value: string | undefined, timeZone: string): string {
  if (!value) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

/** Wall-clock values used to initialize the planning event form. */
export interface DefaultPlanningTimeRange {
  startsAt: string;
  endsAt: string;
}

/**
 * Builds the next full-hour planning range in the installation time zone.
 *
 * When a calendar date is supplied, the start keeps that exact date and only
 * borrows the suggested time of day. A skipped DST hour falls back to noon on
 * the selected date.
 *
 * @param timeZone - IANA time zone configured for the active group.
 * @param selectedDate - Optional strict `YYYY-MM-DD` calendar selection.
 * @param now - Clock instant used to derive the suggested time of day.
 * @returns One-hour start and end values suitable for `datetime-local` inputs.
 * @throws {RangeError} When the time zone is invalid.
 *
 * @example
 * defaultPlanningTimeRange('Europe/Berlin', '2026-09-12', new Date('2026-08-31T08:15:00Z'));
 */
export function defaultPlanningTimeRange(timeZone: string, selectedDate?: string, now = new Date()): DefaultPlanningTimeRange {
  const localNow = toZonedDateTimeInput(now.toISOString(), timeZone);
  const roundedWallClock = new Date(`${localNow}:00Z`);
  roundedWallClock.setUTCMinutes(0, 0, 0);
  roundedWallClock.setUTCHours(roundedWallClock.getUTCHours() + 1);
  const roundedInput = roundedWallClock.toISOString().slice(0, 16);
  let startsAt = `${selectedDate ?? roundedInput.slice(0, 10)}T${roundedInput.slice(11)}`;
  let startIso: string;
  try {
    startIso = zonedDateTimeInputToIso(startsAt, timeZone);
  } catch {
    startsAt = `${selectedDate ?? roundedInput.slice(0, 10)}T12:00`;
    startIso = zonedDateTimeInputToIso(startsAt, timeZone);
  }
  const end = new Date(new Date(startIso).getTime() + 60 * 60_000);
  return { startsAt, endsAt: toZonedDateTimeInput(end.toISOString(), timeZone) };
}
