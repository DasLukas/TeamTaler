import KeyRound from 'lucide-react/dist/esm/icons/key-round';
import { useTranslation } from 'react-i18next';
import { PERMISSION_KEYS, type PermissionDefinition, type PermissionGrant, type PermissionKey } from '@/api/types';
import { effectivePermissionKeys } from '@/app/permissions';
import { Toggle } from '@/components/ui/Toggle';
import styles from './RightsPanel.module.css';

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
  const definitionKeys = new Set(definitions.map((definition) => definition.key));
  const keys = PERMISSION_KEYS.filter((permission) => definitionKeys.size === 0 || definitionKeys.has(permission));
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
      <div className={styles.roleList}>
        {keys.map((permission) => {
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
    </div>
  );
}
