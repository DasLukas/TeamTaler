import { describe, expect, it } from 'vitest';
import type { PlanningRecurrenceInput } from '@/api/types';
import { planningRecurrenceEndIsValid, planningRecurrenceIncludesAnchor, planningRecurrenceIsEditable, planningWeekdayForDate } from './planningRecurrence';

const weekly: PlanningRecurrenceInput = { frequency: 'WEEKLY', interval: 1, weekdays: ['MO'], range: { type: 'NEVER' } };

describe('planning recurrence anchor', () => {
  it('maps local dates to RFC weekday tokens', () => {
    expect(planningWeekdayForDate('2026-08-31T12:00')).toBe('MO');
    expect(planningWeekdayForDate('2026-09-01T12:00')).toBe('TU');
  });

  it('rejects weekly rules that cannot materialize the selected first occurrence', () => {
    expect(planningRecurrenceIncludesAnchor(weekly, '2026-08-31T12:00')).toBe(true);
    expect(planningRecurrenceIncludesAnchor(weekly, '2026-09-01T12:00')).toBe(false);
    expect(planningRecurrenceIncludesAnchor({ frequency: 'DAILY', interval: 1, range: { type: 'NEVER' } }, '2026-09-01T12:00')).toBe(true);
  });

  it('does not offer recurrence while editing a one-off event', () => {
    expect(planningRecurrenceIsEditable('create', '')).toBe(true);
    expect(planningRecurrenceIsEditable('edit', 'series-1')).toBe(true);
    expect(planningRecurrenceIsEditable('edit', '')).toBe(false);
  });

  it('requires a positive duration for recurring events while keeping one-off ends optional', () => {
    expect(planningRecurrenceEndIsValid(null, '2026-08-31T10:00:00Z', undefined, '')).toBe(true);
    expect(planningRecurrenceEndIsValid(weekly, '2026-08-31T10:00:00Z', undefined, '')).toBe(false);
    expect(planningRecurrenceEndIsValid(null, '2026-08-31T10:00:00Z', undefined, '2026-08-31T11:00')).toBe(false);
    expect(planningRecurrenceEndIsValid(weekly, '2026-08-31T10:00:00Z', '2026-08-31T11:00:00Z', '2026-08-31T11:00')).toBe(true);
    expect(planningRecurrenceEndIsValid(weekly, '2026-08-31T10:00:00Z', '2026-08-31T09:00:00Z', '2026-08-31T09:00')).toBe(false);
  });
});
