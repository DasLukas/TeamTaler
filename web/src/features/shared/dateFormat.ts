const germanDateFormatter = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const germanDateTimeFormatter = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const dateOnlyPattern = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Converts a wire timestamp or date-only value into a Date for presentation.
 * Date-only values are constructed in local calendar time so timezone offsets
 * cannot move them to the previous or following day.
 *
 * @param value - ISO date, timestamp, or Date to prepare for formatting.
 * @returns A Date preserving the calendar day of date-only input.
 * @throws {RangeError} The formatter throws when the resulting date is invalid.
 */
function presentationDate(value: string | Date): Date {
  if (value instanceof Date) return value;
  const match = dateOnlyPattern.exec(value);
  if (!match) return new Date(value);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
}

/**
 * Formats a date for German user-facing copy as DD.MM.YYYY.
 *
 * @param value - ISO date, timestamp, or Date to format.
 * @returns The German numeric calendar date.
 * @throws {RangeError} The value cannot be interpreted as a valid date.
 *
 * @example
 * formatGermanDate('2026-09-07') // '07.09.2026'
 */
export function formatGermanDate(value: string | Date): string {
  return germanDateFormatter.format(presentationDate(value));
}

/**
 * Formats a timestamp for German user-facing copy as DD.MM.YYYY, HH:mm.
 *
 * @param value - ISO timestamp or Date to format.
 * @returns The German numeric date and 24-hour time.
 * @throws {RangeError} The value cannot be interpreted as a valid date.
 *
 * @example
 * formatGermanDateTime('2026-09-07T14:48:00Z') // '07.09.2026, 16:48' in Europe/Berlin
 */
export function formatGermanDateTime(value: string | Date): string {
  return germanDateTimeFormatter.format(presentationDate(value));
}
