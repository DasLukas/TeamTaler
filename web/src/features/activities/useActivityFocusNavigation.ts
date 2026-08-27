import { useCallback, useEffect, useState, type RefObject } from 'react';

const activityFocusParameter = 'tt.activities.focus';
const activityFocusHistoryKey = 'teamTalerActivityFocus';

interface ActivityFocusScrollPosition {
  left: number;
  top: number;
}

interface ActivityFocusHistoryState {
  navigationEntry?: boolean;
  scrollPosition?: ActivityFocusScrollPosition;
}

/** Options accepted by {@link useActivityFocusNavigation}. */
export interface UseActivityFocusNavigationOptions {
  /** Mutable render-time index of IDs in the active normal or anchor-backed collection. */
  loadedActivityIdsRef: RefObject<ReadonlySet<string>>;
  /** Active table or card viewport whose position is restored after browser Back. */
  viewportRef: RefObject<HTMLDivElement | null>;
}

/** URL focus state and commands used by the activities feed. */
export interface ActivityFocusNavigation {
  /** Server anchor retained while a context window is required. */
  anchorId?: string;
  /** Removes focus before a search, filter, or sorting change is applied. */
  clearFocusForQueryChange: () => void;
  /** Stable activity ID currently marked in the rendered collection. */
  focusedActivityId?: string;
  /** Returns through browser history or clears a directly opened focus link. */
  leaveFocus: () => void;
  /** Adds a history entry and focuses a loaded row or requests its server context. */
  navigateToActivity: (activityId: string) => void;
  /** Applies and consumes a pending browser-Back scroll position after collection data is ready. */
  restorePendingScrollPosition: () => void;
}

/** Reads the stable activities focus parameter from the current URL. */
function readFocusedActivityId(): string | undefined {
  const value = new URL(window.location.href).searchParams.get(activityFocusParameter)?.trim();
  return value || undefined;
}

/** Preserves application-owned history state while returning a mutable record. */
function historyRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } as Record<string, unknown> : {};
}

/** Reads the activity-specific state embedded in a browser history entry. */
function activityHistoryState(value: unknown): ActivityFocusHistoryState {
  const record = historyRecord(value);
  const activityState = record[activityFocusHistoryKey];
  return typeof activityState === 'object' && activityState !== null ? activityState as ActivityFocusHistoryState : {};
}

/** Replaces the activity-specific payload without discarding router-owned history state. */
function withActivityHistoryState(value: unknown, activityState: ActivityFocusHistoryState): Record<string, unknown> {
  return { ...historyRecord(value), [activityFocusHistoryKey]: activityState };
}

/** Builds the current same-document URL with an optional activity focus. */
function focusedUrl(activityId?: string): string {
  const url = new URL(window.location.href);
  if (activityId) url.searchParams.set(activityFocusParameter, activityId);
  else url.searchParams.delete(activityFocusParameter);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Coordinates shareable activity focus, server anchor selection, browser history,
 * and return-scroll restoration without coupling the generic data table to routing.
 *
 * @param options - Loaded-ID index and the currently active collection viewport.
 * @returns Focus state plus navigation commands for row actions and query controls.
 *
 * @example
 * const focus = useActivityFocusNavigation({ loadedActivityIdsRef, viewportRef });
 * focus.navigateToActivity('reversal:booking:123');
 */
export function useActivityFocusNavigation({ loadedActivityIdsRef, viewportRef }: UseActivityFocusNavigationOptions): ActivityFocusNavigation {
  const [focusedActivityId, setFocusedActivityId] = useState<string | undefined>(readFocusedActivityId);
  const [anchorId, setAnchorId] = useState<string | undefined>(readFocusedActivityId);
  const [pendingScrollPosition, setPendingScrollPosition] = useState<ActivityFocusScrollPosition | undefined>();

  useEffect(() => {
    const synchronizeFromHistory = (event: PopStateEvent) => {
      const nextFocus = readFocusedActivityId();
      setFocusedActivityId(nextFocus);
      setAnchorId((currentAnchor) => {
        if (!nextFocus) return undefined;
        return loadedActivityIdsRef.current.has(nextFocus) ? currentAnchor : nextFocus;
      });
      setPendingScrollPosition(nextFocus ? undefined : activityHistoryState(event.state).scrollPosition);
    };
    window.addEventListener('popstate', synchronizeFromHistory);
    return () => window.removeEventListener('popstate', synchronizeFromHistory);
  }, [loadedActivityIdsRef]);

  const navigateToActivity = useCallback((activityId: string) => {
    const normalizedActivityId = activityId.trim();
    if (!normalizedActivityId) return;
    const viewport = viewportRef.current;
    const currentActivityState = activityHistoryState(window.history.state);
    window.history.replaceState(withActivityHistoryState(window.history.state, {
      ...currentActivityState,
      scrollPosition: { left: viewport?.scrollLeft ?? 0, top: viewport?.scrollTop ?? 0 },
    }), '', focusedUrl(focusedActivityId));
    window.history.pushState(withActivityHistoryState(window.history.state, { navigationEntry: true }), '', focusedUrl(normalizedActivityId));
    setFocusedActivityId(normalizedActivityId);
    setAnchorId((currentAnchor) => loadedActivityIdsRef.current.has(normalizedActivityId) ? currentAnchor : normalizedActivityId);
    setPendingScrollPosition(undefined);
  }, [focusedActivityId, loadedActivityIdsRef, viewportRef]);

  const replaceWithUnfocusedUrl = useCallback((restoreTop: boolean) => {
    const currentActivityState = activityHistoryState(window.history.state);
    window.history.replaceState(withActivityHistoryState(window.history.state, {
      ...currentActivityState,
      navigationEntry: false,
    }), '', focusedUrl());
    setFocusedActivityId(undefined);
    setAnchorId(undefined);
    setPendingScrollPosition(restoreTop ? { left: 0, top: 0 } : undefined);
  }, []);

  const leaveFocus = useCallback(() => {
    if (activityHistoryState(window.history.state).navigationEntry) {
      window.history.back();
      return;
    }
    replaceWithUnfocusedUrl(true);
  }, [replaceWithUnfocusedUrl]);

  const clearFocusForQueryChange = useCallback(() => {
    if (focusedActivityId) replaceWithUnfocusedUrl(false);
  }, [focusedActivityId, replaceWithUnfocusedUrl]);

  const restorePendingScrollPosition = useCallback(() => {
    if (focusedActivityId || !pendingScrollPosition || !viewportRef.current) return;
    viewportRef.current.scrollLeft = pendingScrollPosition.left;
    viewportRef.current.scrollTop = pendingScrollPosition.top;
    setPendingScrollPosition(undefined);
  }, [focusedActivityId, pendingScrollPosition, viewportRef]);

  return { anchorId, clearFocusForQueryChange, focusedActivityId, leaveFocus, navigateToActivity, restorePendingScrollPosition };
}
