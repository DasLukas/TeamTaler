import { describe, expect, it } from 'vitest';
import { isPlanningDate, isPlanningTime, planningContextSearch, validatePlanningSearch } from './planningSearch';

describe('planning URL state', () => {
  it('accepts real calendar dates including leap days', () => {
    expect(isPlanningDate('2028-02-29')).toBe(true);
    expect(isPlanningDate('2026-02-29')).toBe(false);
  });

  it('retains only supported planning context', () => {
    expect(validatePlanningSearch({ date: '2026-09-12', time: '18:30', view: 'agenda', ignored: 'value' })).toEqual({ date: '2026-09-12', time: '18:30', view: 'agenda' });
    expect(validatePlanningSearch({ date: '2026-13-01', time: '24:00', view: 'tiles' })).toEqual({ date: undefined, time: undefined, view: undefined });
    expect(validatePlanningSearch({ view: 'week' }).view).toBe('week');
  });

  it('parses strict wall-clock values and removes create-only time from calendar context', () => {
    expect(isPlanningTime('00:00')).toBe(true);
    expect(isPlanningTime('23:59')).toBe(true);
    expect(isPlanningTime('9:30')).toBe(false);
    expect(isPlanningTime('12:60')).toBe(false);
    expect(planningContextSearch({ date: '2026-09-12', time: '18:30', view: 'week' })).toEqual({ date: '2026-09-12', view: 'week' });
  });
});
