import { useTranslation } from 'react-i18next';
import type { Role } from '@/api/types';
import styles from './RightsPanel.module.css';
import { RoleSelectionList } from './RoleSelectionList';

/** Inputs accepted by the reusable multi-role checkbox group. */
export interface RoleMultiSelectProps {
  roles: Role[];
  roleIds: readonly string[];
  onChange: (roleIds: string[]) => void;
  label: string;
  disabled?: boolean;
  canManageRoles?: boolean;
  canManageGroup?: boolean;
}

/**
 * Renders an explicit multi-role assignment.
 *
 * @param props - Available roles, selected IDs, authorization, and callback.
 * @returns An accessible checkbox group for members and invitations.
 */
export function RoleMultiSelect({ roles, roleIds, onChange, label, disabled = false, canManageRoles = false, canManageGroup = false }: RoleMultiSelectProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.roleSelect}>
      <p>{t('roleManagement.multiRoleHint')}</p>
      <RoleSelectionList canManageGroup={canManageGroup} canManageRoles={canManageRoles} disabled={disabled} label={label} onChange={onChange} roleIds={roleIds} roles={roles} />
    </div>
  );
}
