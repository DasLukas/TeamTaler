import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Role } from '@/api/types';
import { roleDisplayDescription, roleDisplayName } from './roleDisplayName';
import styles from './RoleSelectionList.module.css';

/** Properties accepted by the reusable role selection fieldset. */
export interface RoleSelectionListProps {
  roles: readonly Role[];
  roleIds: readonly string[];
  label: string;
  onChange: (roleIds: string[]) => void;
  disabled?: boolean;
  canManageRoles?: boolean;
  canManageGroup?: boolean;
  lockedRoleIds?: readonly string[];
  hideLegend?: boolean;
}

/**
 * Determines whether the current administrator may change one role assignment.
 *
 * @param role - Role whose assignment may change.
 * @param canManageRoles - Whether ordinary role assignments may change.
 * @param canManageGroup - Whether protected administrator assignments may change.
 * @returns Whether the checkbox may be changed.
 */
function canAssignRole(role: Role, canManageRoles: boolean, canManageGroup: boolean): boolean {
  if (role.presetKey === 'GROUP_ADMINISTRATOR') return canManageGroup;
  const containsAdministration = role.grants.some((grant) => grant.permission === 'GROUP_ADMINISTRATION');
  return containsAdministration ? canManageRoles && canManageGroup : canManageRoles;
}

/**
 * Renders a filterable multi-role checkbox list with protected assignment rules.
 *
 * @param props - Roles, current draft, authorization, locks, and change callback.
 * @returns An accessible fieldset containing the permitted role choices.
 */
export function RoleSelectionList({
  roles,
  roleIds,
  label,
  onChange,
  disabled = false,
  canManageRoles = false,
  canManageGroup = false,
  lockedRoleIds = [],
  hideLegend = false,
}: RoleSelectionListProps) {
  const { t } = useTranslation();
  const searchId = useId();
  const [filter, setFilter] = useState('');
  const selected = new Set(roleIds);
  const locked = new Set(lockedRoleIds);
  const normalizedFilter = filter.trim().toLocaleLowerCase('de-DE');
  const visibleRoles = normalizedFilter
    ? roles.filter((role) => `${roleDisplayName(role)} ${roleDisplayDescription(role)}`.toLocaleLowerCase('de-DE').includes(normalizedFilter))
    : roles;

  const update = (roleId: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(roleId);
    else next.delete(roleId);
    onChange(roles.filter((role) => next.has(role.id)).map((role) => role.id));
  };

  return (
    <fieldset className={styles.selection}>
      <legend className={hideLegend ? 'sr-only' : styles.legend}>{label}</legend>
      {roles.length > 8 ? (
        <input
          aria-label={t('roleManagement.searchRoles')}
          className={styles.search}
          id={searchId}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t('roleManagement.searchRoles')}
          type="search"
          value={filter}
        />
      ) : null}
      <div className={styles.options}>
        {visibleRoles.map((role) => {
          const isLocked = locked.has(role.id);
          const assignable = canAssignRole(role, canManageRoles, canManageGroup);
          const optionDisabled = disabled || isLocked || !assignable;
          const restriction = isLocked ? t('roleManagement.lastAdministratorRequired')
              : !assignable ? t('roleManagement.protectedAssignment') : '';
          return (
            <label className={`${styles.option} ${optionDisabled ? styles.optionDisabled : ''}`} key={role.id}>
              <input
                checked={selected.has(role.id)}
                disabled={optionDisabled}
                onChange={(event) => update(role.id, event.target.checked)}
                type="checkbox"
              />
              <span className={styles.copy}>
                <strong>{roleDisplayName(role)}</strong>
                <small>{roleDisplayDescription(role) || t('roleManagement.noDescription')}</small>
              </span>
              {restriction ? <em className={styles.restriction}>{restriction}</em> : null}
            </label>
          );
        })}
        {visibleRoles.length === 0 ? <p className={styles.empty}>{t('roleManagement.noRoleSearchResults')}</p> : null}
      </div>
    </fieldset>
  );
}
