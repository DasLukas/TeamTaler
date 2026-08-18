import { useTranslation } from 'react-i18next';
import tableStyles from './Table.module.css';

const auditDateTimeFormatter = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });

/** One normalized row rendered by the shared audit-event table. */
export interface AuditEventTableEntry {
  action: string;
  actor: string;
  details: string;
  id: string;
  occurredAt: string;
  subject: string;
}

/** Properties accepted by the shared audit-event table. */
export interface AuditEventTableProps {
  entries: readonly AuditEventTableEntry[];
}

/**
 * Renders immutable audit events in the standard TeamTaler table layout.
 *
 * @param props - Normalized chronological audit entries.
 * @returns A responsive table with time, actor, action, subject, and details columns.
 *
 * @example
 * <AuditEventTable entries={[{ id: 'evt-1', occurredAt: new Date().toISOString(), actor: 'Admin', action: 'group.updated', subject: 'group · grp-1', details: 'Name changed' }]} />
 */
export function AuditEventTable({ entries }: AuditEventTableProps) {
  const { t } = useTranslation();
  return (
    <div className={tableStyles.tableWrap}>
      <table className={tableStyles.table}>
        <thead><tr><th>{t('audit.time')}</th><th>{t('audit.actor')}</th><th>{t('audit.action')}</th><th>{t('audit.subject')}</th><th>{t('common.details')}</th></tr></thead>
        <tbody>{entries.map((entry) => (
          <tr key={entry.id}>
            <td><time dateTime={entry.occurredAt}>{auditDateTimeFormatter.format(new Date(entry.occurredAt))}</time></td>
            <td><strong>{entry.actor}</strong></td>
            <td>{entry.action}</td>
            <td>{entry.subject}</td>
            <td>{entry.details}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
