import { describe, expect, it } from 'vitest';
import { dateKey, defaultPlanningTimeRange, monthGrid, toZonedDateTimeInput, zonedDateKey, zonedDateTimeInputToIso, zonedStartOfDay } from './planningDate';

describe('planning calendar dates', () => {
  it('builds 42 distinct calendar days across a DST transition', () => {
    const days = monthGrid(new Date(2026, 2, 15));
    expect(days).toHaveLength(42);
    expect(new Set(days.map(dateKey)).size).toBe(42);
    expect(days[0].getDay()).toBe(1);
  });

  it('resolves IANA-zone day boundaries without assuming 24-hour days', () => {
    const start = zonedStartOfDay('2026-03-29', 'Europe/Berlin');
    const next = zonedStartOfDay('2026-03-30', 'Europe/Berlin');
    expect(next.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
    expect(zonedDateKey(start, 'Europe/Berlin')).toBe('2026-03-29');
  });

  it('round-trips group-zone wall-clock values independently from the browser zone', () => {
    const iso = zonedDateTimeInputToIso('2026-08-31T18:00', 'Europe/Berlin');
    expect(iso).toBe('2026-08-31T16:00:00.000Z');
    expect(toZonedDateTimeInput(iso, 'Europe/Berlin')).toBe('2026-08-31T18:00');
  });

  it('rejects wall-clock values skipped by the spring DST transition', () => {
    expect(() => zonedDateTimeInputToIso('2026-03-29T02:30', 'Europe/Berlin')).toThrow(RangeError);
  });

  it('keeps the calendar-selected date when initializing a new event', () => {
    const range = defaultPlanningTimeRange('Europe/Berlin', '2026-09-12', new Date('2026-08-31T08:15:00.000Z'));

    expect(range).toEqual({ startsAt: '2026-09-12T11:00', endsAt: '2026-09-12T12:00' });
  });
});
