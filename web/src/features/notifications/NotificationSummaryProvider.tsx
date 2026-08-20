import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, type ReactNode } from 'react';
import { api } from '@/api/client';
import { useActiveGroup } from '@/app/useActiveGroup';
import { supportsWebPush } from '@/features/push/webPush';

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
  const queryClient = useQueryClient();
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

  useEffect(() => {
    if (!supportsWebPush()) return undefined;
    const receiveMessage = (event: MessageEvent<unknown>) => {
      const message = event.data && typeof event.data === 'object' ? event.data as { type?: string } : {};
      if (message.type === 'TEAMTALER_NOTIFICATION_RECEIVED') {
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: ['notification-summary'] }),
          queryClient.invalidateQueries({ queryKey: ['notifications'] }),
        ]);
      }
    };
    navigator.serviceWorker.addEventListener('message', receiveMessage);
    return () => navigator.serviceWorker.removeEventListener('message', receiveMessage);
  }, [queryClient]);

  useEffect(() => {
    const badgeNavigator = navigator as Navigator & {
      clearAppBadge?: () => Promise<void>;
      setAppBadge?: (contents?: number) => Promise<void>;
    };
    const update = data?.unreadCount
      ? badgeNavigator.setAppBadge?.(data.unreadCount)
      : badgeNavigator.clearAppBadge?.();
    void update?.catch(() => undefined);
  }, [data?.unreadCount]);

  return <NotificationSummaryContext.Provider value={data?.unreadCount ?? 0}>{children}</NotificationSummaryContext.Provider>;
}
