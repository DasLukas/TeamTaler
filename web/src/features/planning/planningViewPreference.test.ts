import { beforeEach, describe, expect, it } from 'vitest';
import { PLANNING_VIEW_STORAGE_KEY, readPlanningViewPreference, writePlanningViewPreference } from './planningViewPreference';

describe('planning view preference', () => {
  beforeEach(() => window.localStorage.clear());

  it('round-trips the versioned global view without storing a date', () => {
    writePlanningViewPreference('week');
    expect(readPlanningViewPreference()).toBe('week');
    expect(JSON.parse(window.localStorage.getItem(PLANNING_VIEW_STORAGE_KEY) ?? '')).toEqual({ version: 1, view: 'week' });
  });

  it('rejects malformed, stale, and unsupported values', () => {
    window.localStorage.setItem(PLANNING_VIEW_STORAGE_KEY, '{invalid');
    expect(readPlanningViewPreference()).toBeUndefined();
    window.localStorage.setItem(PLANNING_VIEW_STORAGE_KEY, JSON.stringify({ version: 2, view: 'day' }));
    expect(readPlanningViewPreference()).toBeUndefined();
    window.localStorage.setItem(PLANNING_VIEW_STORAGE_KEY, JSON.stringify({ version: 1, view: 'tiles' }));
    expect(readPlanningViewPreference()).toBeUndefined();
  });

  it('keeps the calendar usable when browser storage is blocked', () => {
    const blocked = {
      getItem: () => { throw new DOMException('Blocked'); },
      setItem: () => { throw new DOMException('Blocked'); },
    };
    expect(readPlanningViewPreference(blocked)).toBeUndefined();
    expect(() => writePlanningViewPreference('agenda', blocked)).not.toThrow();
  });
});
