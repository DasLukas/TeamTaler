import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Bell from 'lucide-react/dist/esm/icons/bell';
import CheckCheck from 'lucide-react/dist/esm/icons/check-check';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { Button } from '@/components/ui/Button';
import { StatePanel } from '@/components/ui/StatePanel';
import styles from './NotificationsPage.module.css';

/**
 * Renders the in-app notification inbox with per-item acknowledgement.
 *
 * @returns A localized notification list or query state.
 */
export function NotificationsPage() {
  const { t } = useTranslation();
  const { activeGroupId } = useActiveGroup();
  const queryClient = useQueryClient();
  const notificationsQuery = useQuery({ queryKey: ['notifications', activeGroupId], queryFn: () => api.getNotifications(activeGroupId) });
  const readMutation = useMutation({
    mutationFn: (id: string) => api.markNotificationRead(activeGroupId, id),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['notifications', activeGroupId] }),
  });

  if (notificationsQuery.isLoading) return <Page title={t('notifications.title')}><StatePanel kind="loading" /></Page>;
  if (!notificationsQuery.data) return <Page title={t('notifications.title')}><StatePanel kind="error" message={t('notifications.error')} /></Page>;

  return (
    <Page intro={t('notifications.intro')} title={t('notifications.title')}>
      {notificationsQuery.data.length === 0 ? <StatePanel kind="empty" message={t('notifications.empty')} /> : (
        <div className={styles.list}>
          {notificationsQuery.data.map((notification) => (
            <article className={`${styles.notification} ${notification.readAt ? styles.read : ''}`} key={notification.id}>
              <span className={styles.icon}><Bell aria-hidden="true" size={21} /></span>
              <div><h2>{notification.title}</h2><p>{notification.message}</p><time>{new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(notification.createdAt))}</time></div>
              {!notification.readAt ? <Button disabled={readMutation.isPending} leadingIcon={<CheckCheck size={17} />} onClick={() => readMutation.mutate(notification.id)} size="small" variant="ghost">{t('notifications.read')}</Button> : <span className={styles.label}>{t('notifications.read')}</span>}
            </article>
          ))}
        </div>
      )}
    </Page>
  );
}
