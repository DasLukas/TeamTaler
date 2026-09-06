import { StrictMode, useMemo } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { PlanningEvent, PlanningRecurrenceInput } from '@/api/types';
import { zonedDateTimeInputToIso } from './planningDate';
import { defaultPlanningFormState, planningDeadlineHoursToMinutes, planningFormStateFromEvent, usePlanningFormState } from './planningFormState';

const recurrence: PlanningRecurrenceInput = { frequency: 'WEEKLY', interval: 1, weekdays: ['MO'], range: { type: 'NEVER' } };
const event: PlanningEvent = {
  id: 'event-1', version: 2, eventType: 'APPOINTMENT_REGISTRATION', status: 'PUBLISHED', title: 'Cached series event', description: 'Description', location: 'Kitchen', allDay: false, timeZone: 'Europe/Berlin', startsAt: '2026-08-31T10:00:00+02:00', endsAt: '2026-08-31T11:00:00+02:00', responseDeadlineMinutesBefore: 60, capacity: 8, waitlistEnabled: true, confirmationRevision: 1, audience: { type: 'SELECTED_TARGETS', roleIds: ['role-1'], memberIds: ['member-1'] }, participation: { invited: 2, attending: 0, maybe: 0, declined: 0, unanswered: 2, waitlisted: 0, reconfirmationRequired: 0 }, canEdit: true, canCancel: true, canRespond: false, canViewParticipants: true, seriesId: 'series-1', originalStartAt: '2026-08-31T10:00:00+02:00',
};

function Harness({ resolved, stableKey = false }: { resolved: boolean; stableKey?: boolean }) {
  const initialState = useMemo(() => resolved ? planningFormStateFromEvent(event, recurrence, 'Europe/Berlin') : defaultPlanningFormState('Europe/Berlin'), [resolved]);
  const [state, updateState] = usePlanningFormState(stableKey ? 'event-1:series-1:Europe/Berlin' : resolved ? 'event-1:series-1:Europe/Berlin' : 'pending', initialState);
  return <><button onClick={() => updateState((current) => ({ ...current, title: 'Local edit' }))} type="button">Edit title</button><output data-testid="form-state">{JSON.stringify(state)}</output></>;
}

describe('usePlanningFormState', () => {
  it('defaults new events to a single selected all-day date', () => {
    expect(defaultPlanningFormState('Europe/Berlin', '2026-09-05')).toMatchObject({ allDay: true, startDate: '2026-09-05', endDate: '2026-09-05', waitlistEnabled: false });
  });

  it('initializes a strict slot selection as a one-hour timed event', () => {
    expect(defaultPlanningFormState('Europe/Berlin', '2026-09-05', '18:30')).toMatchObject({ allDay: false, startsAt: '2026-09-05T18:30', endsAt: '2026-09-05T19:30' });
    expect(defaultPlanningFormState('Europe/Berlin', '2026-09-05', '9:30')).toMatchObject({ allDay: true, startDate: '2026-09-05' });
  });

  it('falls back safely for nonexistent or offset-ambiguous URL wall-clock values', () => {
    expect(defaultPlanningFormState('Europe/Berlin', '2026-03-29', '02:30').allDay).toBe(true);
    expect(defaultPlanningFormState('Europe/Berlin', '2026-10-25', '02:30').allDay).toBe(true);
  });

  it('hydrates all-day edits from the exclusive API end date and keeps timed fallbacks', () => {
    const allDayEvent: PlanningEvent = { ...event, allDay: true, startDate: '2026-10-24', endDateExclusive: '2026-10-27', timeZone: 'Europe/Berlin', startsAt: '2026-10-23T22:00:00Z', endsAt: '2026-10-26T23:00:00Z' };
    const state = planningFormStateFromEvent(allDayEvent, recurrence, 'Europe/Berlin');
    expect(state).toMatchObject({ allDay: true, startDate: '2026-10-24', endDate: '2026-10-26' });
    expect(state.startsAt).toMatch(/^2026-10-24T\d{2}:00$/);
    expect(new Date(zonedDateTimeInputToIso(state.endsAt, 'Europe/Berlin')).getTime() - new Date(zonedDateTimeInputToIso(state.startsAt, 'Europe/Berlin')).getTime()).toBe(60 * 60_000);
  });

  it('adopts cached event and series data under StrictMode without a deferred-effect race', () => {
    const view = render(<StrictMode><Harness resolved={false} /></StrictMode>);
    view.rerender(<StrictMode><Harness resolved /></StrictMode>);

    const state = JSON.parse(screen.getByTestId('form-state').textContent ?? '{}') as Record<string, unknown>;
    expect(state).toMatchObject({ eventType: 'APPOINTMENT_REGISTRATION', title: 'Cached series event', startsAt: '2026-08-31T10:00', endsAt: '2026-08-31T11:00', responseDeadlineHoursBefore: '1', recurrence });
  });

  it('hydrates untouched fields when an early local callback precedes the complete cache snapshot', async () => {
    const user = userEvent.setup();
    const view = render(<StrictMode><Harness resolved={false} stableKey /></StrictMode>);
    await user.click(screen.getByRole('button', { name: 'Edit title' }));
    view.rerender(<StrictMode><Harness resolved stableKey /></StrictMode>);

    expect(JSON.parse(screen.getByTestId('form-state').textContent ?? '{}')).toMatchObject({ eventType: 'APPOINTMENT_REGISTRATION', title: 'Local edit', startsAt: '2026-08-31T10:00', recurrence });
  });
});

describe('planning deadline hours', () => {
  it('converts optional hours into the API minute offset', () => {
    expect(planningDeadlineHoursToMinutes('')).toBeUndefined();
    expect(planningDeadlineHoursToMinutes('1.5')).toBe(90);
    expect(planningDeadlineHoursToMinutes('0')).toBeUndefined();
  });
});
