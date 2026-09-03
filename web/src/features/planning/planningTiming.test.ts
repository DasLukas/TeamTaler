import { describe, expect, it } from 'vitest';
import type { PlanningEvent } from '@/api/types';
import { addPlanningDays, formatPlanningAllDayRange, formatPlanningEventTime, isPlanningDateKey, planningAllDayDateKeys, planningAllDayRangeFromTimed, planningEndDateExclusive, planningEndDateInclusive, planningTimedRangeFromAllDay } from './planningTiming';

describe('planning all-day timing', () => {
  it('uses calendar arithmetic without drifting across DST changes', () => {
    expect(isPlanningDateKey('2028-02-29')).toBe(true);
    expect(isPlanningDateKey('2026-02-29')).toBe(false);
    expect(addPlanningDays('2026-03-28', 2)).toBe('2026-03-30');
    expect(planningEndDateExclusive('2026-10-25')).toBe('2026-10-26');
    expect(planningEndDateInclusive('2026-11-01')).toBe('2026-10-31');
  });

  it('enumerates and formats an inclusive multi-day event without midnight', () => {
    expect(planningAllDayDateKeys('2026-09-05', '2026-09-08')).toEqual(['2026-09-05', '2026-09-06', '2026-09-07']);
    expect(formatPlanningAllDayRange('2026-09-05', '2026-09-08')).toBe('05.09.2026–07.09.2026');
    const event = { allDay: true, startDate: '2026-09-05', endDateExclusive: '2026-09-08' } as PlanningEvent;
    expect(formatPlanningEventTime(event, 'Europe/Berlin', 'Ganztägig')).toBe('Ganztägig');
  });

  it('preserves remembered wall-clock values while switching timing modes', () => {
    expect(planningAllDayRangeFromTimed('2026-09-05T18:30', '2026-09-06T00:00')).toEqual({ startDate: '2026-09-05', endDate: '2026-09-05' });
    expect(planningTimedRangeFromAllDay('2026-09-05', '2026-09-05', '2026-09-05T18:30', '2026-09-06T00:00')).toEqual({ startsAt: '2026-09-05T18:30', endsAt: '2026-09-06T00:00' });
    expect(planningTimedRangeFromAllDay('2026-09-08', '2026-09-09', '2026-09-05T18:30', '2026-09-05T20:00')).toEqual({ startsAt: '2026-09-08T18:30', endsAt: '2026-09-09T20:00' });
  });
});
