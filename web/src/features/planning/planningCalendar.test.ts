import { describe, expect, it } from 'vitest';
import type { PlanningEvent, PlanningEventBase } from '@/api/types';
import { groupPlanningEventsByDate, planningAllDaySegment, planningEventDateKeys } from './planningCalendar';

const base: PlanningEventBase = {
  id: 'event', version: 1, eventType: 'APPOINTMENT', status: 'PUBLISHED', title: 'Event', description: '', location: '', startsAt: '', waitlistEnabled: false, confirmationRevision: 1, audience: { type: 'ALL_ACTIVE_MEMBERS', roleIds: [], memberIds: [] }, participation: { invited: 0, attending: 0, maybe: 0, declined: 0, unanswered: 0, waitlisted: 0, reconfirmationRequired: 0 }, canEdit: false, canCancel: false, canRespond: false, canViewParticipants: false,
};

describe('planning calendar expansion', () => {
  it('expands all-day ranges and exposes start, middle, and end marker segments', () => {
    const event: PlanningEvent = { ...base, allDay: true, startDate: '2026-09-05', endDateExclusive: '2026-09-08', timeZone: 'Europe/Berlin', startsAt: '2026-09-04T22:00:00Z', endsAt: '2026-09-07T22:00:00Z' };
    expect(planningEventDateKeys(event, 'Europe/Berlin')).toEqual(['2026-09-05', '2026-09-06', '2026-09-07']);
    expect(['2026-09-05', '2026-09-06', '2026-09-07'].map((key) => planningAllDaySegment(event, key))).toEqual(['start', 'middle', 'end']);
  });

  it('expands a timed event ending after midnight and orders all-day entries first', () => {
    const timed: PlanningEvent = { ...base, id: 'timed', title: 'Timed', allDay: false, timeZone: 'Europe/Berlin', startsAt: '2026-09-05T21:00:00Z', endsAt: '2026-09-06T01:00:00Z' };
    const allDay: PlanningEvent = { ...base, id: 'all-day', title: 'All day', allDay: true, startDate: '2026-09-06', endDateExclusive: '2026-09-07', timeZone: 'Europe/Berlin', startsAt: '2026-09-05T22:00:00Z', endsAt: '2026-09-06T22:00:00Z' };
    expect(planningEventDateKeys(timed, 'Europe/Berlin')).toEqual(['2026-09-05', '2026-09-06']);
    expect(groupPlanningEventsByDate([timed, allDay], 'Europe/Berlin').get('2026-09-06')?.map((event) => event.id)).toEqual(['all-day', 'timed']);
  });
});
