import { useState } from 'react';
import type { PlanningAudienceType, PlanningEvent, PlanningEventType, PlanningRecurrenceInput } from '@/api/types';
import { defaultPlanningTimeRange, toZonedDateTimeInput, zonedDateTimeInputOccurrences } from './planningDate';
import { isPlanningTime } from './planningSearch';
import { planningAllDayRangeFromTimed, planningEndDateInclusive } from './planningTiming';

/** Mutable fields owned by the planning create/edit form. */
export interface PlanningFormState {
  eventType: PlanningEventType;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  startDate: string;
  endDate: string;
  startsAt: string;
  endsAt: string;
  responseDeadlineHoursBefore: string;
  capacity: string;
  waitlistEnabled: boolean;
  audienceType: PlanningAudienceType;
  roleIds: string[];
  memberIds: string[];
  recurrence: PlanningRecurrenceInput | null;
}

/**
 * Builds an empty create-form state in the group's pinned time zone.
 *
 * @param timeZone - IANA time zone pinned by the group.
 * @param selectedDate - Optional calendar date carried into the create route.
 * @param selectedTime - Optional strict wall-clock time selected in a day or week grid.
 * @returns Complete initial state for a new planning event.
 */
export function defaultPlanningFormState(timeZone: string, selectedDate?: string, selectedTime?: string): PlanningFormState {
  let range = defaultPlanningTimeRange(timeZone, selectedDate);
  let allDay = true;
  if (selectedDate && isPlanningTime(selectedTime)) {
    const startsAt = `${selectedDate}T${selectedTime}`;
    try {
      const occurrences = zonedDateTimeInputOccurrences(startsAt, timeZone);
      if (occurrences.length !== 1) throw new RangeError('The selected wall-clock time is ambiguous.');
      const [startInstant] = occurrences;
      const endsAt = toZonedDateTimeInput(new Date(new Date(startInstant).getTime() + 60 * 60_000).toISOString(), timeZone);
      range = { startsAt, endsAt };
      allDay = false;
    } catch {
      // A skipped DST wall-clock time intentionally falls back to a safe all-day event.
    }
  }
  const startDate = range.startsAt.slice(0, 10);
  return { eventType: 'APPOINTMENT', title: '', description: '', location: '', allDay, startDate, endDate: startDate, startsAt: range.startsAt, endsAt: range.endsAt, responseDeadlineHoursBefore: '', capacity: '', waitlistEnabled: false, audienceType: 'ALL_ACTIVE_MEMBERS', roleIds: [], memberIds: [], recurrence: null };
}

function responseDeadlineHours(event: PlanningEvent): string {
  let minutes = event.responseDeadlineMinutesBefore;
  if (minutes === undefined) {
    if (!event.responseDeadline) return '';
    minutes = Math.max(1, Math.round((new Date(event.startsAt).getTime() - new Date(event.responseDeadline).getTime()) / 60_000));
  }
  return String(Math.round(minutes / 60 * 100) / 100);
}

/**
 * Converts an optional form value expressed in hours into the API's integer-minute offset.
 *
 * @param value - User-entered hours before the event start; an empty value disables the deadline.
 * @returns A bounded positive minute offset, or `undefined` when the value is empty or invalid.
 */
export function planningDeadlineHoursToMinutes(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return undefined;
  const minutes = Math.round(hours * 60);
  return minutes >= 1 && minutes <= 525_600 ? minutes : undefined;
}

/**
 * Builds edit-form state from a materialized occurrence and optional series rule.
 *
 * @param event - Persisted materialized occurrence returned by the API.
 * @param recurrence - Recurrence owned by the occurrence's series, when present.
 * @param timeZone - Pinned series or group IANA time zone.
 * @returns Complete state ready for the edit form.
 */
export function planningFormStateFromEvent(event: PlanningEvent, recurrence: PlanningRecurrenceInput | null, timeZone: string): PlanningFormState {
  const timedRange = event.allDay
    ? defaultPlanningTimeRange(timeZone, event.startDate)
    : { startsAt: toZonedDateTimeInput(event.startsAt, timeZone), endsAt: toZonedDateTimeInput(event.endsAt, timeZone) };
  const allDayRange = event.allDay
    ? { startDate: event.startDate, endDate: planningEndDateInclusive(event.endDateExclusive) }
    : planningAllDayRangeFromTimed(timedRange.startsAt, timedRange.endsAt);
  return {
    eventType: event.eventType,
    title: event.title,
    description: event.description,
    location: event.location,
    allDay: event.allDay,
    startDate: allDayRange.startDate,
    endDate: allDayRange.endDate,
    startsAt: timedRange.startsAt,
    endsAt: timedRange.endsAt,
    responseDeadlineHoursBefore: responseDeadlineHours(event),
    capacity: event.capacity ? String(event.capacity) : '',
    waitlistEnabled: event.waitlistEnabled,
    audienceType: event.audience.type === 'ALL_ACTIVE_MEMBERS' ? 'ALL_ACTIVE_MEMBERS' : 'SELECTED_TARGETS',
    roleIds: event.audience.roleIds,
    memberIds: event.audience.memberIds,
    recurrence,
  };
}

interface StoredPlanningFormState {
  initializationKey: string;
  overrides: Partial<PlanningFormState>;
}

function formFieldEqual(left: PlanningFormState[keyof PlanningFormState], right: PlanningFormState[keyof PlanningFormState]): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeFormState(initialValue: PlanningFormState, overrides: Partial<PlanningFormState>): PlanningFormState {
  return { ...initialValue, ...overrides };
}

function formStateOverrides(next: PlanningFormState, initialValue: PlanningFormState): Partial<PlanningFormState> {
  const overrides: Partial<PlanningFormState> = {};
  for (const key of Object.keys(next) as Array<keyof PlanningFormState>) {
    if (!formFieldEqual(next[key], initialValue[key])) Object.assign(overrides, { [key]: next[key] });
  }
  return overrides;
}

/**
 * Owns form edits while synchronously adopting newly resolved query data.
 *
 * Query-derived state remains authoritative for every untouched field. Local
 * overrides are stored per field so an early browser callback cannot retain
 * an incomplete cache snapshot during an SPA route transition. Unlike
 * effect-based initialization, this is also safe when React StrictMode
 * replays mounts.
 *
 * @param initializationKey - Stable identity of the resolved event, series, and time zone.
 * @param initialValue - State derived synchronously from the latest query snapshot.
 * @returns Current state and a functional updater that always uses the active key.
 */
export function usePlanningFormState(initializationKey: string, initialValue: PlanningFormState) {
  const [stored, setStored] = useState<StoredPlanningFormState | null>(null);
  const state = stored?.initializationKey === initializationKey ? mergeFormState(initialValue, stored.overrides) : initialValue;
  const updateState = (updater: (current: PlanningFormState) => PlanningFormState) => setStored((current) => {
    const active = current?.initializationKey === initializationKey ? mergeFormState(initialValue, current.overrides) : initialValue;
    return { initializationKey, overrides: formStateOverrides(updater(active), initialValue) };
  });
  return [state, updateState] as const;
}
