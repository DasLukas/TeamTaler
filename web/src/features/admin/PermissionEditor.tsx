import KeyRound from 'lucide-react/dist/esm/icons/key-round';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { PERMISSION_KEYS, type PermissionDefinition, type PermissionGrant, type PermissionKey } from '@/api/types';
import { effectivePermissionKeys } from '@/app/permissions';
import { Toggle } from '@/components/ui/Toggle';
import styles from './RightsPanel.module.css';

type PermissionGroupKey = 'administration' | 'bookings' | 'finance' | 'catalog';

const PERMISSION_GROUPS: ReadonlyArray<{ key: PermissionGroupKey; permissions: readonly PermissionKey[] }> = [
  {
    key: 'administration',
    permissions: ['GROUP_ADMINISTRATION', 'MEMBER_MANAGEMENT', 'ROLE_MANAGEMENT'],
  },
  {
    key: 'bookings',
    permissions: ['CREATE_OWN_BOOKING', 'BOOK_FOR_OTHERS', 'BOOK_FOR_GUESTS', 'VOID_OWN_BOOKING', 'VOID_ANY_BOOKING', 'VIEW_ALL_BOOKING_ACTIVITY'],
  },
  {
    key: 'finance',
    permissions: ['FINANCE_MANAGEMENT', 'RECORD_OWN_PAYMENT', 'VIEW_GROUP_STATISTICS'],
  },
  {
    key: 'catalog',
    permissions: ['CATALOG_MANAGEMENT'],
  },
];

/** Inputs for the controlled role grant editor. */
export interface PermissionEditorProps {
  definitions: PermissionDefinition[];
  value: PermissionGrant[];
  onChange: (value: PermissionGrant[]) => void;
  disabled?: boolean;
  protectedPermissions?: readonly PermissionKey[];
}
/**
 * Renders all stable permissions as group-scoped role grants.
 *
 * Direct grants remain distinguishable from implied permissions so the client
 * never persists redundant grants. Only enabled group scopes are presented.
 *
 * @param props - Registry metadata, direct grants, and protected role rules.
 * @returns A localized, accessible permission matrix.
 */
export function PermissionEditor({ definitions, value, onChange, disabled = false, protectedPermissions = [] }: PermissionEditorProps) {
  const { t } = useTranslation();
  const headingPrefix = useId();
  const definitionKeys = new Set(definitions.map((definition) => definition.key));
  const availableKeys = new Set(PERMISSION_KEYS.filter((permission) => definitionKeys.size === 0 || definitionKeys.has(permission)));
  const direct = new Set(value.filter((grant) => grant.scope.type === 'GROUP').map((grant) => grant.permission));
  const effective = effectivePermissionKeys(value);
  const protectedSet = new Set(protectedPermissions);

  const toggle = (permission: PermissionKey, checked: boolean) => {
    const remaining = value.filter((grant) => grant.permission !== permission || grant.scope.type !== 'GROUP');
    onChange(checked ? [...remaining, { permission, scope: { type: 'GROUP' } }] : remaining);
  };

  return (
    <div className={styles.editor}>
      <div className={styles.permissionHeading}>
        <h3>{t('roleManagement.permissionsTitle')}</h3>
      </div>
      <div className={styles.permissionGroups}>
        {PERMISSION_GROUPS.map((group) => {
          const permissions = group.permissions.filter((permission) => availableKeys.has(permission));
          if (permissions.length === 0) return null;
          const headingId = `${headingPrefix}-${group.key}`;
          return (
            <section aria-labelledby={headingId} className={styles.permissionGroup} key={group.key}>
              <h4 id={headingId}>{t(`roleManagement.permissionGroups.${group.key}`)}</h4>
              <div className={styles.roleList}>
                {permissions.map((permission) => {
                  const implied = effective.has(permission) && !direct.has(permission);
                  const isProtected = protectedSet.has(permission);
                  return (
                    <div className={styles.permissionCard} key={permission}>
                      <KeyRound aria-hidden="true" size={30} strokeWidth={1.5} />
                      <div>
                        <strong>{t(`permissions.${permission}.label`)}</strong>
                        <span>{t(`permissions.${permission}.description`)}</span>
                        {implied ? <small className={styles.implied}>{t('roleManagement.impliedPermission')}</small> : null}
                      </div>
                      <Toggle
                        checked={direct.has(permission)}
                        disabled={disabled || isProtected || implied}
                        label={t('roleManagement.togglePermission', { permission: t(`permissions.${permission}.label`) })}
                        onChange={(checked) => toggle(permission, checked)}
                      />
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
