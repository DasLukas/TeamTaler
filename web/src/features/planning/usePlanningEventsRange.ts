import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { api } from '@/api/client';
import type { PlanningEvent, PlanningEventPage } from '@/api/types';
import { planningKeys } from './planningQueryKeys';
import type { PlanningVisibleRange } from './planningView';

/** Result returned by the visible-range planning event hook. */
export interface PlanningEventsRangeResult {
  events: PlanningEvent[];
  isError: boolean;
  isInitialLoading: boolean;
  isLoadingMore: boolean;
  refetch: () => Promise<unknown>;
}

/**
 * Loads every cursor page intersecting a bounded calendar range.
 *
 * Accumulated pages stay renderable while later pages are fetched, avoiding a
 * full-calendar loading replacement for dense periods.
 *
 * @param groupId - Active group identifier.
 * @param range - Inclusive visible dates represented as an exclusive instant range.
 * @param enabled - Whether group settings and permissions permit the query.
 * @returns Flattened events plus initial and background loading states.
 */
export function usePlanningEventsRange(groupId: string, range: PlanningVisibleRange, enabled: boolean): PlanningEventsRangeResult {
  const query = useInfiniteQuery({
    enabled,
    getNextPageParam: (lastPage: PlanningEventPage) => lastPage.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }): Promise<PlanningEventPage> => api.getPlanningEvents(groupId, { cursor: pageParam, from: range.from, fromDate: range.fromDate, limit: 200, to: range.to, toDateExclusive: range.toDateExclusive }),
    queryKey: planningKeys.eventRange(groupId, range.from, range.to),
  });
  const { fetchNextPage, hasNextPage, isError, isFetchingNextPage } = query;
  useEffect(() => {
    if (!isError && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isError, isFetchingNextPage]);
  const events = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data?.pages]);
  return {
    events,
    isError: query.isError,
    isInitialLoading: query.isPending && events.length === 0,
    isLoadingMore: Boolean(query.hasNextPage || query.isFetchingNextPage),
    refetch: query.refetch,
  };
}
