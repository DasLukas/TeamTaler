import { useTranslation } from 'react-i18next';
import type { MembershipStatus } from '@/api/types';
import tableStyles from '@/features/shared/Table.module.css';

/** Properties for a localized membership lifecycle badge. */
export interface MembershipStatusBadgeProps {
  status: MembershipStatus;
}

/**
 * Renders one membership lifecycle state with the shared semantic table colors.
 *
 * @param props - Current membership lifecycle state.
 * @returns A localized active, former, or deleted status badge.
 */
export function MembershipStatusBadge({ status }: MembershipStatusBadgeProps) {
  const { t } = useTranslation();
  const label = status === 'ACTIVE' ? t('financeWorkspace.active') : status === 'ARCHIVED' ? t('financeWorkspace.archived') : t('common.deleted');
  const tone = status === 'ACTIVE' ? '' : status === 'ARCHIVED' ? tableStyles.statusWarning : tableStyles.statusDanger;
  return <span className={`${tableStyles.status} ${tone}`}>{label}</span>;
}
