import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { isValidCustomStatisticsRange, statisticsQueryFromUrlState, useStatisticsUrlState } from './statisticsUrlState';

afterEach(() => window.history.replaceState({}, '', '/'));

describe('statistics URL state', () => {
  it('starts with an omitted server-default range and normalizes metadata without changing the request', () => {
    window.history.replaceState({}, '', '/statistics?view=members');
    const { result } = renderHook(() => useStatisticsUrlState('group-a'));

    expect(result.current.range).toBeNull();
    expect(result.current.query).toEqual({});
    act(() => result.current.normalizeResolvedRange('LAST_30_DAYS'));

    expect(result.current.range).toBe('LAST_30_DAYS');
    expect(result.current.query).toEqual({});
    expect(new URLSearchParams(window.location.search).get('range')).toBe('LAST_30_DAYS');
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);
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
    const { result } = renderHook(() => useStatisticsUrlState('group-a'));

    expect(result.current.query).toEqual({ range: 'CURRENT_PERIOD' });
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);
  });

  it('synchronizes range changes restored by browser history', () => {
    window.history.replaceState({}, '', '/statistics?range=LAST_30_DAYS');
    const { result } = renderHook(() => useStatisticsUrlState('group-a'));

    act(() => result.current.setRange('ALL_TIME'));
    expect(result.current.query).toEqual({ range: 'ALL_TIME' });

    act(() => {
      window.history.replaceState({}, '', '/statistics?range=LAST_30_DAYS');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(result.current.query).toEqual({ range: 'LAST_30_DAYS' });
  });

  it('re-resolves an automatic range when the active group changes', () => {
    window.history.replaceState({}, '', '/statistics?view=members');
    const firstGroup = renderHook(() => useStatisticsUrlState('group-a'));
    act(() => firstGroup.result.current.normalizeResolvedRange('LAST_30_DAYS'));
    firstGroup.unmount();

    const secondGroup = renderHook(() => useStatisticsUrlState('group-b'));
    expect(secondGroup.result.current.range).toBeNull();
    expect(secondGroup.result.current.query).toEqual({});
  });

});
