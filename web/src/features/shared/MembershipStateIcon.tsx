import Archive from 'lucide-react/dist/esm/icons/archive';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import { useTranslation } from 'react-i18next';
import type { MembershipStatus } from '@/api/types';
import styles from './MembershipStateIcon.module.css';

export interface MembershipStateIconProps {
  showLabelAtWide?: boolean;
  status?: MembershipStatus;
}

/**
 * Renders the lifecycle state of a historical membership as an accessible icon.
 *
 * @param props - Membership status and optional wide-screen label behavior.
 * @returns A warning archive icon, a danger trash icon, or nothing for active memberships.
 */
export function MembershipStateIcon({ showLabelAtWide = false, status }: MembershipStateIconProps) {
  const { t } = useTranslation();
  if (status !== 'ARCHIVED' && status !== 'DELETED') return null;

  const label = status === 'ARCHIVED' ? t('common.archived') : t('common.deleted');
  const StateIcon = status === 'ARCHIVED' ? Archive : Trash2;

  return (
    <span
      aria-label={label}
      className={`${styles.state} ${status === 'DELETED' ? styles.deleted : styles.archived} ${showLabelAtWide ? styles.wide : ''}`}
      role="img"
      title={label}
    >
      <StateIcon aria-hidden="true" size={14} />
      {showLabelAtWide ? <span className={styles.label}>{label}</span> : null}
    </span>
  );
}
