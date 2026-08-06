import Archive from 'lucide-react/dist/esm/icons/archive';
import Calculator from 'lucide-react/dist/esm/icons/calculator';
import CircleDollarSign from 'lucide-react/dist/esm/icons/circle-dollar-sign';
import Crown from 'lucide-react/dist/esm/icons/crown';
import Info from 'lucide-react/dist/esm/icons/info';
import ShieldCheck from 'lucide-react/dist/esm/icons/shield-check';
import { useTranslation } from 'react-i18next';
import type { Category, CategoryPermission, GroupRole, PermissionUpdate } from '@/api/types';
import { Toggle } from '@/components/ui/Toggle';
import styles from './RightsPanel.module.css';

const roleRows: Array<{ role: Exclude<GroupRole, 'MEMBER'>; labelKey: string; descriptionKey: string; icon: typeof Crown }> = [
  { role: 'ADMIN', labelKey: 'roles.admin.label', descriptionKey: 'roles.admin.description', icon: Crown },
  { role: 'FINANCE_MANAGER', labelKey: 'roles.finance.label', descriptionKey: 'roles.finance.description', icon: Calculator },
  { role: 'CATALOG_MANAGER', labelKey: 'roles.catalog.label', descriptionKey: 'roles.catalog.description', icon: Archive },
];

/** Inputs for the controlled group and category permission editor. */
export interface PermissionEditorProps {
  categories: Category[];
  value: PermissionUpdate;
  subjectName: string;
  onChange: (value: PermissionUpdate) => void;
  showAuditNotice?: boolean;
}

/**
 * Renders the shared controlled role and category-right matrix.
 *
 * @param props - Categories, current permission value, subject label, and change callback.
 * @returns A localized permission editor without persistence behavior.
 */
export function PermissionEditor({ categories, value, subjectName, onChange, showAuditNotice = false }: PermissionEditorProps) {
  const { t } = useTranslation();
  const toggleRole = (role: Exclude<GroupRole, 'MEMBER'>, checked: boolean) => onChange({
    ...value,
    roles: checked ? [...new Set([...value.roles, role])] : value.roles.filter((entry) => entry !== role),
  });
  const toggleSelfPayment = (checked: boolean) => onChange({
    ...value,
    groupPermissions: checked
      ? [...new Set([...value.groupPermissions, 'SELF_RECORD_PAYMENT' as const])]
      : value.groupPermissions.filter((permission) => permission !== 'SELF_RECORD_PAYMENT'),
  });
  const updateCategoryPermission = (categoryId: string, field: keyof Pick<CategoryPermission, 'assignToOthers' | 'voidBookings'>, checked: boolean) => {
    const current = value.categoryPermissions.find((permission) => permission.categoryId === categoryId)
      ?? { categoryId, assignToOthers: false, voidBookings: false };
    const next = { ...current, [field]: checked };
    const remaining = value.categoryPermissions.filter((permission) => permission.categoryId !== categoryId);
    onChange({
      ...value,
      categoryPermissions: next.assignToOthers || next.voidBookings ? [...remaining, next] : remaining,
    });
  };

  return (
    <div className={styles.editor}>
      <h3>{t('rights.groupRoles')}</h3>
      <div className={styles.roleList}>
        {roleRows.map(({ role, labelKey, descriptionKey, icon: Icon }) => (
          <div className={styles.role} key={role}>
            <Icon aria-hidden="true" size={34} strokeWidth={1.5} />
            <div><strong>{t(labelKey)}</strong><span>{t(descriptionKey)}</span></div>
            <Toggle checked={value.roles.includes(role)} label={t('rights.toggleRole', { role: t(labelKey), name: subjectName })} onChange={(checked) => toggleRole(role, checked)} />
            <Info aria-hidden="true" className={styles.info} size={22} />
          </div>
        ))}
      </div>
      <h3 className={styles.categoryTitle}>{t('rights.additionalRights')}</h3>
      <div className={styles.roleList}>
        <div className={styles.role}>
          <CircleDollarSign aria-hidden="true" size={34} strokeWidth={1.5} />
          <div><strong>{t('rights.selfPayment.label')}</strong><span>{t('rights.selfPayment.description')}</span></div>
          <Toggle checked={value.groupPermissions.includes('SELF_RECORD_PAYMENT')} label={t('rights.selfPayment.toggle', { name: subjectName })} onChange={toggleSelfPayment} />
          <Info aria-hidden="true" className={styles.info} size={22} />
        </div>
      </div>
      <h3 className={styles.categoryTitle}>{t('rights.categoryRights')}</h3>
      <div className={styles.permissionTable}>
        <div className={styles.tableHead}><strong>{t('common.category')}</strong><strong>{t('rights.assignOthers')}</strong><strong>{t('rights.voidBookings')}</strong><span /></div>
        {categories.map((category) => {
          const permission = value.categoryPermissions.find((entry) => entry.categoryId === category.id)
            ?? { categoryId: category.id, assignToOthers: false, voidBookings: false };
          return (
            <div className={styles.permissionRow} key={category.id}>
              <strong>{category.name}</strong>
              <Toggle checked={permission.assignToOthers} label={t('rights.categoryAssign', { category: category.name })} onChange={(checked) => updateCategoryPermission(category.id, 'assignToOthers', checked)} />
              <Toggle checked={permission.voidBookings} label={t('rights.categoryVoid', { category: category.name })} onChange={(checked) => updateCategoryPermission(category.id, 'voidBookings', checked)} />
              <Info aria-hidden="true" className={styles.info} size={22} />
            </div>
          );
        })}
      </div>
      {showAuditNotice ? <p className={styles.notice}><ShieldCheck aria-hidden="true" size={20} /> {t('rights.auditNotice')}</p> : null}
    </div>
  );
}
