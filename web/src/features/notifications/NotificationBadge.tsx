import { useTranslation } from 'react-i18next';
import styles from './NotificationBadge.module.css';

/**
 * Renders a compact unread counter while announcing the uncapped exact value.
 *
 * @param props - Exact count and optional placement class.
 * @returns A badge or null when no unread notifications exist.
 */
export function NotificationBadge({ count, className = '' }: { count: number; className?: string }) {
  const { t } = useTranslation();
  if (count <= 0) return null;
  return <span aria-label={t('notifications.unreadCount', { count })} className={`${styles.badge} ${className}`.trim()}>{count > 99 ? '99+' : count}</span>;
}
