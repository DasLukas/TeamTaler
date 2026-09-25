import KeyRound from 'lucide-react/dist/esm/icons/key-round';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { PERMISSION_KEYS, type Group, type PermissionDefinition, type PermissionGrant, type PermissionKey } from '@/api/types';
import { effectivePermissionKeys } from '@/app/permissions';
import { Toggle } from '@/components/ui/Toggle';
import styles from './RightsPanel.module.css';

type PermissionGroupKey = 'administration' | 'bookings' | 'statistics' | 'finance' | 'catalog' | 'planning';

const PERMISSION_GROUPS: ReadonlyArray<{ key: PermissionGroupKey; permissions: readonly PermissionKey[] }> = [
  {
    key: 'administration',
    permissions: ['GROUP_ADMINISTRATION', 'MEMBER_MANAGEMENT', 'ROLE_MANAGEMENT'],
  },
  {
    key: 'bookings',
    permissions: ['CREATE_OWN_BOOKING', 'BOOK_FOR_OTHERS', 'BOOK_FOR_GUESTS', 'USE_KIOSK', 'VOID_OWN_BOOKING', 'VOID_ANY_BOOKING', 'VIEW_ALL_BOOKING_ACTIVITY'],
  },
  {
    key: 'statistics',
    permissions: ['VIEW_STATISTICS'],
  },
  {
    key: 'finance',
    permissions: ['FINANCE_MANAGEMENT', 'VIEW_EXTERNAL_ACCOUNTS', 'MANAGE_EXTERNAL_ACCOUNTS', 'RECORD_OWN_PAYMENT'],
  },
  {
    key: 'catalog',
    permissions: ['CATALOG_MANAGEMENT'],
  },
  {
    key: 'planning',
    permissions: ['USE_PLANNING', 'CREATE_PLANNING_EVENTS', 'VIEW_PLANNING_PARTICIPANTS', 'MANAGE_PLANNING_EVENTS'],
  },
];

type FeatureAvailability = Pick<Group, 'kioskEnabled' | 'statisticsEnabled' | 'externalAccountsEnabled' | 'planningEnabled'>;
type FeatureFlag = keyof FeatureAvailability;

const REQUIRED_FEATURE_BY_PERMISSION: Partial<Record<PermissionKey, FeatureFlag>> = {
  USE_KIOSK: 'kioskEnabled',
  VIEW_STATISTICS: 'statisticsEnabled',
  VIEW_EXTERNAL_ACCOUNTS: 'externalAccountsEnabled',
  MANAGE_EXTERNAL_ACCOUNTS: 'externalAccountsEnabled',
  USE_PLANNING: 'planningEnabled',
  CREATE_PLANNING_EVENTS: 'planningEnabled',
  VIEW_PLANNING_PARTICIPANTS: 'planningEnabled',
  MANAGE_PLANNING_EVENTS: 'planningEnabled',
};

const FEATURE_NAME_BY_FLAG: Record<FeatureFlag, 'kiosk' | 'statistics' | 'externalAccounts' | 'planning'> = {
  kioskEnabled: 'kiosk',
  statisticsEnabled: 'statistics',
  externalAccountsEnabled: 'externalAccounts',
  planningEnabled: 'planning',
};

/** Inputs for the controlled role grant editor. */
export interface PermissionEditorProps {
  definitions: PermissionDefinition[];
  value: PermissionGrant[];
  onChange: (value: PermissionGrant[]) => void;
  featureAvailability?: FeatureAvailability;
  disabled?: boolean;
  protectedPermissions?: readonly PermissionKey[];
}
/**
 * Renders all stable permissions as group-scoped role grants.
 *
 * Direct grants remain distinguishable from implied permissions so the client
 * never persists redundant grants. Only enabled group scopes are presented.
 *
 * @param props - Registry metadata, direct grants, feature availability, and protected role rules.
 * @returns A localized, accessible permission matrix.
 */
export function PermissionEditor({ definitions, value, onChange, featureAvailability, disabled = false, protectedPermissions = [] }: PermissionEditorProps) {
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
                  const featureFlag = REQUIRED_FEATURE_BY_PERMISSION[permission];
                  const inactiveFeature = featureFlag && featureAvailability && featureAvailability[featureFlag] !== true ? featureFlag : undefined;
                  const featureNoticeId = inactiveFeature ? `${headingId}-${permission}-feature-notice` : undefined;
                  return (
                    <div className={styles.permissionCard} key={permission}>
                      <KeyRound aria-hidden="true" size={30} strokeWidth={1.5} />
                      <div>
                        <strong>{t(`permissions.${permission}.label`)}</strong>
                        <span>{t(`permissions.${permission}.description`)}</span>
                        {inactiveFeature || implied ? <div className={styles.permissionBadges}>
                          {inactiveFeature ? <small className={styles.featureNotice} id={featureNoticeId}>{t('roleManagement.inactiveFeatureNotice', { feature: t(`roleManagement.featureNames.${FEATURE_NAME_BY_FLAG[inactiveFeature]}`) })}</small> : null}
                          {implied ? <small className={styles.implied}>{t('roleManagement.impliedPermission')}</small> : null}
                        </div> : null}
                      </div>
                      <Toggle
                        checked={effective.has(permission)}
                        descriptionId={featureNoticeId}
                        disabled={disabled || isProtected || implied}
                        label={t('roleManagement.togglePermission', { permission: t(`permissions.${permission}.label`) })}
                        muted={Boolean(inactiveFeature)}
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
