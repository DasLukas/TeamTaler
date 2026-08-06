import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, type ReactNode } from 'react';
import { api } from '@/api/client';
import { useActiveGroup } from '@/app/useActiveGroup';

import { NotificationSummaryContext } from './NotificationSummaryContext';
import { notificationSummaryKey } from './notification-summary';

/**
 * Loads the navigation-level unread count once and refreshes it on route changes.
 * React Query owns focus and reconnect subscriptions globally, avoiding duplicate
 * window listeners across navigation consumers.
 *
 * @param props - Authenticated application-shell descendants.
 * @returns A provider exposing the exact unread count.
 */
export function NotificationSummaryProvider({ children }: { children: ReactNode }) {
  const { activeGroupId } = useActiveGroup();
  const routeHref = useRouterState({ select: (state) => state.location.href });
  const previousRoute = useRef(routeHref);
  const { data, refetch } = useQuery({
    queryKey: notificationSummaryKey(activeGroupId),
    queryFn: () => api.getNotificationSummary(activeGroupId),
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (previousRoute.current !== routeHref) {
      previousRoute.current = routeHref;
      void refetch();
    }
  }, [refetch, routeHref]);

  return <NotificationSummaryContext.Provider value={data?.unreadCount ?? 0}>{children}</NotificationSummaryContext.Provider>;
}
