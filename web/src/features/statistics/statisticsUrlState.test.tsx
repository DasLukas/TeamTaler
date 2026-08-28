import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { isValidCustomStatisticsRange, statisticsQueryFromUrlState, useStatisticsUrlState } from './statisticsUrlState';

afterEach(() => window.history.replaceState({}, '', '/'));

describe('statistics URL state', () => {
  it('starts with an omitted server-default range and normalizes metadata without changing the request', () => {
    window.history.replaceState({}, '', '/statistics?view=members');
    const { result } = renderHook(() => useStatisticsUrlState(['members', 'finance'], 'group-a'));

    expect(result.current.range).toBeNull();
    expect(result.current.query).toEqual({});
    act(() => result.current.normalizeResolvedRange('LAST_30_DAYS'));

    expect(result.current.range).toBe('LAST_30_DAYS');
    expect(result.current.query).toEqual({});
    expect(new URLSearchParams(window.location.search).get('range')).toBe('LAST_30_DAYS');
  });

  it('uses inclusive local date-only values only for a complete CUSTOM range', () => {
    expect(statisticsQueryFromUrlState({ range: 'CUSTOM', from: '2026-08-01', to: '2026-08-31' })).toEqual({
      range: 'CUSTOM', from: '2026-08-01', to: '2026-08-31',
    });
    expect(isValidCustomStatisticsRange({ range: 'CUSTOM', from: '2026-08-31', to: '2026-08-01' })).toBe(false);
    expect(statisticsQueryFromUrlState({ range: 'CUSTOM', from: '2026-08-31', to: '' })).toBeNull();
  });

  it('preserves an explicit current-period deep link for server validation', () => {
    window.history.replaceState({}, '', '/statistics?view=finance&range=CURRENT_PERIOD');
    const { result } = renderHook(() => useStatisticsUrlState(['members', 'finance'], 'group-a'));

    expect(result.current.view).toBe('finance');
    expect(result.current.query).toEqual({ range: 'CURRENT_PERIOD' });
  });

  it('re-resolves an automatic range when the active group changes', () => {
    window.history.replaceState({}, '', '/statistics?view=members');
    const firstGroup = renderHook(() => useStatisticsUrlState(['members'], 'group-a'));
    act(() => firstGroup.result.current.normalizeResolvedRange('LAST_30_DAYS'));
    firstGroup.unmount();

    const secondGroup = renderHook(() => useStatisticsUrlState(['members'], 'group-b'));
    expect(secondGroup.result.current.range).toBeNull();
    expect(secondGroup.result.current.query).toEqual({});
  });

});
