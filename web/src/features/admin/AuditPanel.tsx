import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { useActiveGroup } from '@/app/useActiveGroup';
import { StatePanel } from '@/components/ui/StatePanel';
import tableStyles from '@/features/shared/Table.module.css';
import styles from './AuditPanel.module.css';

/**
 * Renders the read-only audit log for administrative and finance actions.
 *
 * @returns A localized immutable-event table or query state.
 */
export function AuditPanel() {
  const { t } = useTranslation();
  const { activeGroupId } = useActiveGroup();
  const auditQuery = useQuery({ queryKey: ['audit', activeGroupId], queryFn: () => api.getAudit(activeGroupId) });
  if (auditQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (!auditQuery.data) return <div className={styles.state}><StatePanel kind="error" message={t('audit.error')} /></div>;
  return (
    <div className={styles.content}>
      <header><h2>{t('audit.title')}</h2><p>{t('audit.intro')}</p></header>
      {auditQuery.data.length === 0 ? <StatePanel kind="empty" message={t('audit.empty')} /> : <div className={tableStyles.tableWrap}><table className={tableStyles.table}><thead><tr><th>{t('audit.time')}</th><th>{t('audit.actor')}</th><th>{t('audit.action')}</th><th>{t('audit.subject')}</th><th>{t('common.details')}</th></tr></thead><tbody>{auditQuery.data.map((entry) => <tr key={entry.id}><td>{new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(entry.occurredAt))}</td><td><strong>{entry.actorName}</strong></td><td>{entry.action}</td><td>{entry.subject}</td><td>{entry.details}</td></tr>)}</tbody></table></div>}
    </div>
  );
}
