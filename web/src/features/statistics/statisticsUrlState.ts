import { useCallback, useEffect, useMemo, useState } from 'react';
import { isStatisticsRange, type StatisticsQuery, type StatisticsRange } from '@/api/types';
import type { StatisticsView } from '@/app/groupCapabilities';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SERVER_DEFAULT_SCOPE_KEY = 'teamTalerStatisticsDefaultScope';

/** Complete shareable statistics page state. */
export interface StatisticsUrlState {
  view: StatisticsView;
  range: StatisticsRange | null;
  from: string;
  to: string;
}

/** Controlled URL state returned by {@link useStatisticsUrlState}. */
export interface StatisticsUrlStateController extends StatisticsUrlState {
  setView: (view: StatisticsView) => void;
  setRange: (range: StatisticsRange) => void;
  setCustomDates: (from: string, to: string) => void;
  normalizeResolvedRange: (range: StatisticsRange) => void;
  query: StatisticsQuery | null;
}

/** Returns today's local calendar date in the date-input wire format. */
function localDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Creates a useful initial inclusive custom range without UTC date drift. */
function defaultCustomDates(): Pick<StatisticsUrlState, 'from' | 'to'> {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 29);
  return { from: localDateValue(from), to: localDateValue(to) };
}

/** Returns browser history state without the statistics default marker. */
function historyStateWithoutServerDefault(): unknown {
  const historyState = window.history.state;
  if (!historyState || typeof historyState !== 'object') return historyState;
  const remainingState = { ...historyState } as Record<string, unknown>;
  delete remainingState[SERVER_DEFAULT_SCOPE_KEY];
  return remainingState;
}

/** Reads and normalizes statistics state from the current browser URL. */
function readUrlState(availableViews: readonly StatisticsView[]): StatisticsUrlState {
  const parameters = new URLSearchParams(window.location.search);
  const requestedView = parameters.get('view');
  const view = availableViews.includes(requestedView as StatisticsView) ? requestedView as StatisticsView : availableViews[0];
  if (!view) throw new Error('Statistics URL state requires at least one available view.');
  const requestedRange = parameters.get('range');
  const rangeWasServerDefault = typeof (window.history.state as Record<string, unknown> | null)?.[SERVER_DEFAULT_SCOPE_KEY] === 'string';
  const range = !rangeWasServerDefault && isStatisticsRange(requestedRange) ? requestedRange : null;
  return {
    view,
    range,
    from: parameters.get('from') ?? '',
    to: parameters.get('to') ?? '',
  };
}

/** Writes only statistics-owned parameters while retaining unrelated URL state. */
function writeUrlState(state: StatisticsUrlState, mode: 'push' | 'replace', historyState: unknown = window.history.state): void {
  const url = new URL(window.location.href);
  url.searchParams.set('view', state.view);
  if (state.range) url.searchParams.set('range', state.range);
  else url.searchParams.delete('range');
  if (state.range === 'CUSTOM' && state.from) url.searchParams.set('from', state.from);
  else url.searchParams.delete('from');
  if (state.range === 'CUSTOM' && state.to) url.searchParams.set('to', state.to);
  else url.searchParams.delete('to');
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  if (mode === 'push') window.history.pushState(historyState, '', nextUrl);
  else window.history.replaceState(historyState, '', nextUrl);
}

/**
 * Determines whether an inclusive custom range can be sent to the API.
 *
 * @param state - Current shareable statistics selection.
 * @returns Whether both date-only values are valid and ordered.
 */
export function isValidCustomStatisticsRange(state: Pick<StatisticsUrlState, 'range' | 'from' | 'to'>): boolean {
  if (state.range !== 'CUSTOM') return true;
  return DATE_ONLY_PATTERN.test(state.from) && DATE_ONLY_PATTERN.test(state.to) && state.from <= state.to;
}

/**
 * Converts page state to the exact query accepted by statistics endpoints.
 *
 * @param state - Current range and inclusive custom date values.
 * @returns A server query, or `null` while a custom range is incomplete.
 */
export function statisticsQueryFromUrlState(state: Pick<StatisticsUrlState, 'range' | 'from' | 'to'>): StatisticsQuery | null {
  if (!isValidCustomStatisticsRange(state)) return null;
  if (!state.range) return {};
  return state.range === 'CUSTOM'
    ? { range: state.range, from: state.from, to: state.to }
    : { range: state.range };
}

/**
 * Owns view and range state in canonical, back/forward-aware URL parameters.
 *
 * @param availableViews - Ordered views authorized for the active group.
 * @param resolutionScope - Active group identifier used to scope server-selected defaults.
 * @returns Controlled state and explicit navigation callbacks.
 */
export function useStatisticsUrlState(availableViews: readonly StatisticsView[], resolutionScope: string): StatisticsUrlStateController {
  const availableViewsKey = availableViews.join('|');
  const stableAvailableViews = useMemo(() => availableViewsKey.split('|').filter(Boolean) as StatisticsView[], [availableViewsKey]);
  const [state, setState] = useState<StatisticsUrlState>(() => readUrlState(stableAvailableViews));
  const [serverDefaultResolved, setServerDefaultResolved] = useState(false);
  const normalizedView = stableAvailableViews.includes(state.view) ? state.view : stableAvailableViews[0];
  const normalizedState = useMemo(() => state.view === normalizedView ? state : { ...state, view: normalizedView }, [normalizedView, state]);

  useEffect(() => {
    if (normalizedState.view) writeUrlState(normalizedState, 'replace');
  }, [normalizedState]);

  useEffect(() => {
    const synchronizeFromHistory = () => {
      setServerDefaultResolved(false);
      setState(readUrlState(stableAvailableViews));
    };
    window.addEventListener('popstate', synchronizeFromHistory);
    return () => window.removeEventListener('popstate', synchronizeFromHistory);
  }, [stableAvailableViews]);

  const update = useCallback((next: StatisticsUrlState, mode: 'push' | 'replace') => {
    writeUrlState(next, mode);
    setState(next);
  }, []);

  const setView = useCallback((view: StatisticsView) => update({ ...normalizedState, view }, 'push'), [normalizedState, update]);
  const setRange = useCallback((range: StatisticsRange) => {
    const customDates = range === 'CUSTOM' && (!normalizedState.from || !normalizedState.to) ? defaultCustomDates() : { from: normalizedState.from, to: normalizedState.to };
    setServerDefaultResolved(false);
    const next = { ...normalizedState, ...customDates, range };
    writeUrlState(next, 'push', historyStateWithoutServerDefault());
    setState(next);
  }, [normalizedState]);
  const setCustomDates = useCallback((from: string, to: string) => {
    setServerDefaultResolved(false);
    const next = { ...normalizedState, from, to };
    writeUrlState(next, 'replace', historyStateWithoutServerDefault());
    setState(next);
  }, [normalizedState]);
  const normalizeResolvedRange = useCallback((range: StatisticsRange) => {
    if (normalizedState.range) return;
    const normalized = { ...normalizedState, range };
    setServerDefaultResolved(true);
    const currentHistoryState = window.history.state;
    const historyState = currentHistoryState && typeof currentHistoryState === 'object'
      ? { ...currentHistoryState, [SERVER_DEFAULT_SCOPE_KEY]: resolutionScope }
      : { [SERVER_DEFAULT_SCOPE_KEY]: resolutionScope };
    writeUrlState(normalized, 'replace', historyState);
    setState(normalized);
  }, [normalizedState, resolutionScope]);

  const query = serverDefaultResolved ? {} : statisticsQueryFromUrlState(normalizedState);
  return { ...normalizedState, setView, setRange, setCustomDates, normalizeResolvedRange, query };
}
