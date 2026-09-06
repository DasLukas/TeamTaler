import { describe, expect, it } from 'vitest';
import { adaptDashboard, adaptPlanningEvent, adaptPlanningParticipant, adaptPlanningSeries, adaptPlanningSettings } from './adapters';

const baseEvent = {
  id: 'event-1', eventType: 'APPOINTMENT_POLL', status: 'PUBLISHED', title: 'Shift meal', startsAt: '2026-08-31T16:00:00Z', endsAt: null,
  audienceType: 'SELECTED_MEMBERS', targetMembershipIds: ['member-1'], targetRoleIds: [], confirmationRevision: 2, version: 3,
  counts: { invited: 3, yes: 1, maybe: 0, no: 0, pending: 1, registered: 0, waitlisted: 0, reconfirmationRequired: 1 },
  myParticipation: { status: 'YES', effectiveStatus: 'RECONFIRMATION_REQUIRED', updatedAt: '2026-08-30T12:00:00Z' },
};

describe('planning adapters', () => {
  it('preserves an optional end and keeps a legacy response effective', () => {
    const event = adaptPlanningEvent(baseEvent);
    expect(event).toMatchObject({ allDay: false, timeZone: 'UTC' });
    expect(event.endsAt).toBeUndefined();
    expect(event.audience).toEqual({ type: 'SELECTED_MEMBERS', roleIds: [], memberIds: ['member-1'] });
    expect(event.participation).toMatchObject({ attending: 1, unanswered: 1, reconfirmationRequired: 0 });
    expect(event.viewerParticipation?.status).toBe('ATTENDING');
    expect(event.viewerParticipation?.wireStatus).toBe('YES');
  });

  it('preserves date-only event timing and its pinned time zone', () => {
    expect(adaptPlanningEvent({ ...baseEvent, allDay: true, startDate: '2026-10-24', endDateExclusive: '2026-10-27', timeZone: 'Europe/Berlin', startsAt: '2026-10-23T22:00:00Z', endsAt: '2026-10-26T23:00:00Z', originalStartDate: '2026-10-24' })).toMatchObject({
      allDay: true, startDate: '2026-10-24', endDateExclusive: '2026-10-27', timeZone: 'Europe/Berlin', originalStartDate: '2026-10-24',
    });
  });

  it('normalizes registration and waitlist wire statuses', () => {
    expect(adaptPlanningEvent({ ...baseEvent, eventType: 'APPOINTMENT_REGISTRATION', myParticipation: { effectiveStatus: 'REGISTERED' } }).viewerParticipation?.status).toBe('ATTENDING');
    expect(adaptPlanningEvent({ ...baseEvent, eventType: 'APPOINTMENT_REGISTRATION', myParticipation: { effectiveStatus: 'WAITLISTED' } }).viewerParticipation?.status).toBe('WAITLISTED');
    expect(adaptPlanningEvent({ ...baseEvent, myParticipation: { status: 'WITHDRAWN', effectiveStatus: 'WITHDRAWN' } }).viewerParticipation).toMatchObject({ status: 'WITHDRAWN', wireStatus: 'WITHDRAWN' });
  });

  it('uses registration totals even when the shared poll total is zero', () => {
    const event = adaptPlanningEvent({
      ...baseEvent,
      eventType: 'APPOINTMENT_REGISTRATION',
      counts: { ...baseEvent.counts, yes: 0, registered: 2 },
    });

    expect(event.participation.attending).toBe(2);
  });

  it('adapts the installation timezone and structured series recurrence', () => {
    expect(adaptPlanningSettings({ enabled: true, version: 2, timeZone: 'Europe/Berlin' })).toMatchObject({ enabled: true, version: 2, timeZone: 'Europe/Berlin' });
    expect(adaptPlanningSeries({ id: 'series-1', status: 'PUBLISHED', timeZone: 'Europe/Berlin', eventType: 'APPOINTMENT_POLL', title: 'Meal', durationMinutes: 60, audienceType: 'SELECTED_TARGETS', targetRoleIds: ['role-1'], targetMembershipIds: ['member-1'], version: 1, recurrence: { frequency: 'WEEKLY', interval: 2, weekdays: ['MO', 'FR'], range: { type: 'COUNT', count: 8 } } })).toMatchObject({
      audience: { type: 'SELECTED_TARGETS', roleIds: ['role-1'], memberIds: ['member-1'] },
      recurrence: { frequency: 'WEEKLY', interval: 2, weekdays: ['MO', 'FR'], range: { type: 'COUNT', count: 8 } },
      timeZone: 'Europe/Berlin',
    });
  });

  it('adapts all-day series duration in complete calendar days', () => {
    expect(adaptPlanningSeries({ id: 'series-all-day', allDay: true, startDate: '2026-09-05', durationDays: 3, status: 'PUBLISHED', timeZone: 'Europe/Berlin', eventType: 'APPOINTMENT', title: 'Weekend', audienceType: 'ALL_ACTIVE_MEMBERS', version: 1, recurrence: { frequency: 'YEARLY', interval: 1, range: { type: 'NEVER' } } })).toMatchObject({
      allDay: true, startDate: '2026-09-05', durationDays: 3,
    });
  });

  it('preserves series identity and exception state on event occurrences', () => {
    expect(adaptPlanningEvent({ ...baseEvent, seriesId: 'series-1', originalStartAt: '2026-08-31T16:00:00Z', isSeriesException: true, responseDeadlineMinutesBefore: 180 })).toMatchObject({
      seriesId: 'series-1', originalStartAt: '2026-08-31T16:00:00Z', isSeriesException: true, responseDeadlineMinutesBefore: 180,
    });
  });

  it('preserves withdrawn as the effective participant state', () => {
    expect(adaptPlanningParticipant({ membershipId: 'member-1', displayName: 'Ada', status: 'WITHDRAWN', effectiveStatus: 'WITHDRAWN' })).toMatchObject({ status: 'WITHDRAWN', effectiveStatus: 'WITHDRAWN' });
  });

  it('uses the event-specific dashboard action and viewer projection', () => {
    const dashboard = adaptDashboard({
      openBalance: { minorUnits: 0, currency: 'EUR' }, currentPeriod: {}, categoryTotals: [], groupCategoryTotals: [], recentBookings: [],
      openPlanningActionCount: 7,
      nextPlanningEvent: { ...baseEvent, actionRequired: false, canRespond: true, myParticipation: undefined, myParticipationStatus: 'MAYBE', myEffectiveStatus: 'MAYBE' },
    });
    expect(dashboard.planning?.actionRequired).toBe(false);
    expect(dashboard.planning?.event.canRespond).toBe(true);
    expect(dashboard.planning?.event.viewerParticipation?.status).toBe('MAYBE');
  });

});
