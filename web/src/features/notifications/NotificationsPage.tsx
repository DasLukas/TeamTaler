import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import Bell from 'lucide-react/dist/esm/icons/bell';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { NotificationPage, NotificationSummary } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { Button } from '@/components/ui/Button';
import { StatePanel } from '@/components/ui/StatePanel';
import { notificationSummaryKey } from './notification-summary';
import styles from './NotificationsPage.module.css';

const notificationListKey = (groupId: string) => ['notifications', groupId] as const;

/**
 * Renders the cursor-backed notification inbox and acknowledges each unread
 * card as soon as it intersects the viewport.
 *
 * @returns A localized infinite notification list or query state.
 */
export function NotificationsPage() {
  const { t } = useTranslation();
  const { activeGroupId } = useActiveGroup();
  const queryClient = useQueryClient();
  const listRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const queuedIDs = useRef(new Set<string>());
  const acknowledgedIDs = useRef(new Set<string>());
  const failedIDs = useRef(new Set<string>());
  const mutationBusy = useRef(false);
  const flushRef = useRef<() => void>(() => undefined);
  const [acknowledgementFailed, setAcknowledgementFailed] = useState(false);

  const notificationsQuery = useInfiniteQuery({
    queryKey: notificationListKey(activeGroupId),
    queryFn: ({ pageParam }) => api.getNotificationsPage(activeGroupId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = notificationsQuery;

  const readMutation = useMutation({
    mutationFn: (ids: string[]) => api.markNotificationsRead(activeGroupId, ids),
    onMutate: async (ids) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: notificationListKey(activeGroupId) }),
        queryClient.cancelQueries({ queryKey: notificationSummaryKey(activeGroupId) }),
      ]);
      const previousPages = queryClient.getQueryData<InfiniteData<NotificationPage>>(notificationListKey(activeGroupId));
      const previousSummary = queryClient.getQueryData<NotificationSummary>(notificationSummaryKey(activeGroupId));
      const idSet = new Set(ids);
      const optimisticReadAt = new Date().toISOString();
      queryClient.setQueryData<InfiniteData<NotificationPage>>(notificationListKey(activeGroupId), (current) => current ? ({
        ...current,
        pages: current.pages.map((page) => ({ ...page, items: page.items.map((item) => idSet.has(item.id) ? { ...item, readAt: optimisticReadAt } : item) })),
      }) : current);
      if (previousSummary) {
        queryClient.setQueryData<NotificationSummary>(notificationSummaryKey(activeGroupId), { unreadCount: Math.max(0, previousSummary.unreadCount - ids.length) });
      }
      return { previousPages, previousSummary };
    },
    onSuccess: (result, ids) => {
      const idSet = new Set(ids);
      queryClient.setQueryData<InfiniteData<NotificationPage>>(notificationListKey(activeGroupId), (current) => current ? ({
        ...current,
        pages: current.pages.map((page) => ({ ...page, items: page.items.map((item) => idSet.has(item.id) ? { ...item, readAt: result.readAt } : item) })),
      }) : current);
      queryClient.setQueryData<NotificationSummary>(notificationSummaryKey(activeGroupId), { unreadCount: result.unreadCount });
      ids.forEach((id) => failedIDs.current.delete(id));
      setAcknowledgementFailed(failedIDs.current.size > 0);
    },
    onError: (_error, ids, rollback) => {
      if (rollback?.previousPages) queryClient.setQueryData(notificationListKey(activeGroupId), rollback.previousPages);
      if (rollback?.previousSummary) queryClient.setQueryData(notificationSummaryKey(activeGroupId), rollback.previousSummary);
      ids.forEach((id) => {
        acknowledgedIDs.current.delete(id);
        failedIDs.current.add(id);
      });
      setAcknowledgementFailed(true);
    },
    onSettled: () => {
      mutationBusy.current = false;
      flushRef.current();
    },
  });
  const markRead = readMutation.mutate;

  const flushQueued = useCallback(() => {
    if (mutationBusy.current || queuedIDs.current.size === 0) return;
    const ids = Array.from(queuedIDs.current).slice(0, 100);
    ids.forEach((id) => queuedIDs.current.delete(id));
    mutationBusy.current = true;
    markRead(ids);
  }, [markRead]);

  useEffect(() => {
    flushRef.current = flushQueued;
  }, [flushQueued]);

  const queueVisible = useCallback((ids: string[]) => {
    ids.forEach((id) => {
      if (acknowledgedIDs.current.has(id) || failedIDs.current.has(id)) return;
      acknowledgedIDs.current.add(id);
      queuedIDs.current.add(id);
    });
    queueMicrotask(() => flushRef.current());
  }, []);

  const retryFailed = useCallback(() => {
    const ids = Array.from(failedIDs.current);
    failedIDs.current.clear();
    setAcknowledgementFailed(false);
    queueVisible(ids);
  }, [queueVisible]);

  const notifications = useMemo(() => notificationsQuery.data?.pages.flatMap((page) => page.items) ?? [], [notificationsQuery.data]);
  const unreadSignature = notifications.filter((item) => !item.readAt).map((item) => item.id).join('|');

  useEffect(() => {
    const root = listRef.current;
    if (!root) return undefined;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).map((entry) => (entry.target as HTMLElement).dataset.notificationId).filter((id): id is string => Boolean(id));
      if (visible.length > 0) queueVisible(visible);
    }, { threshold: 0 });
    root.querySelectorAll<HTMLElement>('[data-unread="true"]').forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [queueVisible, unreadSignature]);

  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!sentinel || !hasNextPage) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    }, { rootMargin: '240px 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  useEffect(() => {
    window.addEventListener('focus', retryFailed);
    window.addEventListener('online', retryFailed);
    return () => {
      window.removeEventListener('focus', retryFailed);
      window.removeEventListener('online', retryFailed);
    };
  }, [retryFailed]);

  if (notificationsQuery.isLoading) return <Page title={t('notifications.title')}><StatePanel kind="loading" /></Page>;
  if (notificationsQuery.isError) return <Page title={t('notifications.title')}><StatePanel kind="error" message={t('notifications.error')} /></Page>;

  return (
    <Page intro={t('notifications.intro')} title={t('notifications.title')}>
      {acknowledgementFailed ? <div className={styles.acknowledgementError} role="alert"><span>{t('notifications.readError')}</span><Button onClick={retryFailed} size="small" variant="ghost">{t('common.retry')}</Button></div> : null}
      {notifications.length === 0 ? <StatePanel kind="empty" message={t('notifications.empty')} /> : (
        <div className={styles.list} ref={listRef}>
          {notifications.map((notification) => (
            <article className={`${styles.notification} ${notification.readAt ? styles.read : ''}`} data-notification-id={notification.id} data-unread={notification.readAt ? 'false' : 'true'} key={notification.id}>
              <span className={styles.icon}><Bell aria-hidden="true" size={21} /></span>
              <div><h2>{notification.title}</h2><p>{notification.message}</p><time>{new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(notification.createdAt))}</time></div>
              <span className={styles.label}>{notification.readAt ? t('notifications.read') : t('notifications.new')}</span>
            </article>
          ))}
          <div aria-hidden="true" className={styles.sentinel} ref={loadMoreRef} />
          {notificationsQuery.isFetchingNextPage ? <p className={styles.loadingMore}>{t('notifications.loadingMore')}</p> : null}
        </div>
      )}
    </Page>
  );
}
