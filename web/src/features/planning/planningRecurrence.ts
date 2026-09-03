import type { PlanningRecurrenceInput, PlanningWeekday } from '@/api/types';

const planningWeekdays: PlanningWeekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/**
 * Maps a local planning date-time input to its RFC weekday token.
 *
 * @param localDateTime - Local `datetime-local` value whose date is the recurrence anchor.
 * @returns RFC weekday abbreviation used by the planning API.
 */
export function planningWeekdayForDate(localDateTime: string): PlanningWeekday {
  const date = new Date(`${localDateTime.slice(0, 10)}T00:00:00Z`);
  return planningWeekdays[(date.getUTCDay() + 6) % 7] ?? 'MO';
}

/**
 * Verifies that a weekly recurrence can materialize the selected first occurrence.
 *
 * @param recurrence - Structured recurrence selected by the user.
 * @param startsAt - Local start date-time of the first occurrence.
 * @returns `true` for non-weekly rules or when the weekly rule contains the anchor weekday.
 */
export function planningRecurrenceIncludesAnchor(recurrence: PlanningRecurrenceInput | null, startsAt: string): boolean {
  return !recurrence
    || recurrence.frequency !== 'WEEKLY'
    || Boolean(recurrence.weekdays?.includes(planningWeekdayForDate(startsAt)));
}

/**
 * Determines whether the planning form can persist recurrence changes.
 *
 * @param mode - Form operation currently shown to the user.
 * @param seriesId - Existing series identifier, if the edited occurrence belongs to a series.
 * @returns `true` for new events and existing series occurrences, never for one-off event edits.
 */
export function planningRecurrenceIsEditable(mode: 'create' | 'edit', seriesId: string): boolean {
  return mode === 'create' || Boolean(seriesId);
}

/**
 * Validates the end needed to derive a stable duration for every series occurrence.
 *
 * @param recurrence - Current recurrence selection, or `null` for a one-off event.
 * @param startsAt - Parsed ISO start instant, if the local input is valid.
 * @param endsAt - Parsed ISO end instant, if supplied and valid.
 * @param endInput - Raw local end input used to distinguish an empty optional end from an invalid value.
 * @returns `true` when an optional one-off end is absent or a supplied end follows the start.
 */
export function planningRecurrenceEndIsValid(recurrence: PlanningRecurrenceInput | null, startsAt: string | undefined, endsAt: string | undefined, endInput: string): boolean {
  if (!endInput) return recurrence === null;
  return startsAt !== undefined && endsAt !== undefined && new Date(endsAt).getTime() > new Date(startsAt).getTime();
}

/** Returns a localized, human-readable summary for a structured recurrence rule. */
export function planningRecurrenceSummary(recurrence: PlanningRecurrenceInput, t: (key: string, values?: Record<string, unknown>) => string): string {
  const frequency = t(`planning.recurrence.frequencySummary.${recurrence.frequency}`, { count: recurrence.interval });
  const weekdaySummary = recurrence.frequency === 'WEEKLY' && recurrence.weekdays?.length
    ? ` ${t('planning.recurrence.onWeekdays', { weekdays: recurrence.weekdays.map((day) => t(`planning.recurrence.weekdays.${day}.short`)).join(', ') })}`
    : '';
  const monthlySummary = recurrence.frequency === 'MONTHLY' && recurrence.monthlyMode
    ? ` · ${t(`planning.recurrence.monthlyModes.${recurrence.monthlyMode}`)}`
    : '';
  const rangeSummary = recurrence.range.type === 'COUNT'
    ? t('planning.recurrence.rangeSummary.count', { count: recurrence.range.count })
    : recurrence.range.type === 'UNTIL'
      ? t('planning.recurrence.rangeSummary.until', { date: new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${recurrence.range.until}T00:00:00Z`)) })
      : t('planning.recurrence.rangeSummary.never');
  return `${frequency}${weekdaySummary}${monthlySummary} · ${rangeSummary}`;
}
