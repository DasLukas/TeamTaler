import { describe, expect, it } from 'vitest';
import type { PlanningEvent, PlanningEventBase } from '@/api/types';
import { zonedDateTimeInputOccurrences } from './planningDate';
import { initialPlanningTimeSlot, layoutPlanningAllDayEvents, layoutPlanningTimedEvents, planningSlotTime } from './planningTimeGridLayout';

const base: PlanningEventBase = {
  id: 'event', version: 1, eventType: 'APPOINTMENT', status: 'PUBLISHED', title: 'Event', description: '', location: '', startsAt: '', waitlistEnabled: false, confirmationRevision: 1, audience: { type: 'ALL_ACTIVE_MEMBERS', roleIds: [], memberIds: [] }, participation: { invited: 0, attending: 0, maybe: 0, declined: 0, unanswered: 0, waitlisted: 0, reconfirmationRequired: 0 }, canEdit: false, canCancel: false, canRespond: false, canViewParticipants: false,
};

function timed(id: string, startsAt: string, endsAt: string): PlanningEvent {
  return { ...base, id, title: id, allDay: false, timeZone: 'Europe/Berlin', startsAt, endsAt };
}

describe('planning time-grid layout', () => {
  it('places visual overlaps in columns and clips a multi-day event per day', () => {
    const overnight = timed('overnight', '2026-09-01T20:00:00Z', '2026-09-02T08:00:00Z');
    const overlap = timed('overlap', '2026-09-02T07:00:00Z', '2026-09-02T09:00:00Z');
    const firstDay = layoutPlanningTimedEvents([overnight, overlap], '2026-09-01', 'Europe/Berlin');
    const secondDay = layoutPlanningTimedEvents([overnight, overlap], '2026-09-02', 'Europe/Berlin');
    expect(firstDay.find((entry) => entry.event.id === 'overnight')).toMatchObject({ startMinute: 22 * 60, endMinute: 1440 });
    expect(secondDay.find((entry) => entry.event.id === 'overnight')).toMatchObject({ startMinute: 0, endMinute: 10 * 60, columnCount: 2 });
    expect(secondDay.find((entry) => entry.event.id === 'overlap')?.columnCount).toBe(2);
  });

  it('spans all-day events across visible columns without duplicating them', () => {
    const event: PlanningEvent = { ...base, allDay: true, startDate: '2026-09-01', endDateExclusive: '2026-09-04', timeZone: 'Europe/Berlin', startsAt: '2026-08-31T22:00:00Z', endsAt: '2026-09-03T22:00:00Z' };
    expect(layoutPlanningAllDayEvents([event], ['2026-09-01', '2026-09-02', '2026-09-03'])).toEqual([{ event, startColumn: 0, endColumn: 3, row: 0 }]);
  });

  it('prefers now, then the first event, then 08:00', () => {
    expect(initialPlanningTimeSlot([], ['2026-09-01'], 'Europe/Berlin', new Date('2026-09-01T10:17:00Z'))).toEqual({ date: '2026-09-01', minute: 12 * 60 });
    expect(initialPlanningTimeSlot([timed('later', '2026-09-02T07:15:00Z', '2026-09-02T08:00:00Z')], ['2026-09-02'], 'Europe/Berlin', new Date('2026-09-01T10:17:00Z'))).toEqual({ date: '2026-09-02', minute: 9 * 60 });
    expect(initialPlanningTimeSlot([], ['2026-09-03'], 'Europe/Berlin', new Date('2026-09-01T10:17:00Z'))).toEqual({ date: '2026-09-03', minute: 8 * 60 });
    expect(planningSlotTime(9 * 60 + 30)).toBe('09:30');
  });

  it('detects both offsets of the autumn fold while rejecting its spring gap', () => {
    expect(zonedDateTimeInputOccurrences('2026-10-25T02:30', 'Europe/Berlin')).toHaveLength(2);
    expect(() => zonedDateTimeInputOccurrences('2026-03-29T02:30', 'Europe/Berlin')).toThrow(RangeError);
  });
});
