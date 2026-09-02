import { describe, expect, it } from 'vitest';
import { formatPlanningViewLabel, movePlanningViewAnchor, planningMonthDateKeys, planningViewDateKeys, planningVisibleRange, planningWeekStart } from './planningView';

describe('planning calendar views', () => {
  it('uses Monday-first day, week, month, and 90-day agenda ranges', () => {
    expect(planningWeekStart('2026-09-03')).toBe('2026-08-31');
    expect(planningViewDateKeys('day', '2026-09-03')).toEqual(['2026-09-03']);
    expect(planningViewDateKeys('week', '2026-09-03')).toEqual(['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06']);
    expect(planningMonthDateKeys('2026-09-03')).toHaveLength(42);
    expect(planningViewDateKeys('agenda', '2026-09-03')).toHaveLength(90);
  });

  it('builds civil and instant boundaries without assuming 24-hour DST days', () => {
    const day = planningVisibleRange('day', '2026-03-29', 'Europe/Berlin');
    expect(day).toMatchObject({ fromDate: '2026-03-29', toDateExclusive: '2026-03-30' });
    expect(new Date(day.to).getTime() - new Date(day.from).getTime()).toBe(23 * 60 * 60_000);
    const week = planningVisibleRange('week', '2026-10-25', 'Europe/Berlin');
    expect(week.fromDate).toBe('2026-10-19');
    expect(week.toDateExclusive).toBe('2026-10-26');
  });

  it('moves by the active period and keeps a valid month day', () => {
    expect(movePlanningViewAnchor('day', '2026-09-01', 1)).toBe('2026-09-02');
    expect(movePlanningViewAnchor('week', '2026-09-01', -1)).toBe('2026-08-25');
    expect(movePlanningViewAnchor('month', '2026-01-31', 1)).toBe('2026-02-28');
    expect(movePlanningViewAnchor('agenda', '2026-09-01', 1)).toBe('2026-11-30');
    expect(formatPlanningViewLabel('week', '2026-09-01')).toContain('2026');
  });

  it('keeps localized day and month pairs together in compact period labels', () => {
    const weekLabel = formatPlanningViewLabel('week', '2026-09-01');
    expect(weekLabel).toContain('31.\u00a0Aug.');
    expect(weekLabel).toContain('6.\u00a0Sept.');
    expect(formatPlanningViewLabel('day', '2026-09-01')).toContain('1.\u00a0September');
  });
});
