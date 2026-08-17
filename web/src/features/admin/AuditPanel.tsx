import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { useActiveGroup } from '@/app/useActiveGroup';
import { StatePanel } from '@/components/ui/StatePanel';
import { AuditEventTable } from '@/features/shared/AuditEventTable';
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
      {auditQuery.data.length === 0 ? <StatePanel kind="empty" message={t('audit.empty')} /> : <AuditEventTable entries={auditQuery.data.map((entry) => ({ ...entry, actor: entry.actorName }))} />}
    </div>
  );
}
