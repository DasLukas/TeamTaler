import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Archive from 'lucide-react/dist/esm/icons/archive';
import Calculator from 'lucide-react/dist/esm/icons/calculator';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right';
import Crown from 'lucide-react/dist/esm/icons/crown';
import Info from 'lucide-react/dist/esm/icons/info';
import Search from 'lucide-react/dist/esm/icons/search';
import ShieldCheck from 'lucide-react/dist/esm/icons/shield-check';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { CategoryPermission, GroupRole, Membership } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/FormField';
import { StatePanel } from '@/components/ui/StatePanel';
import { Toggle } from '@/components/ui/Toggle';
import styles from './RightsPanel.module.css';

const roleRows: Array<{ role: Exclude<GroupRole, 'MEMBER'>; labelKey: string; descriptionKey: string; icon: typeof Crown }> = [
  { role: 'ADMIN', labelKey: 'roles.admin.label', descriptionKey: 'roles.admin.description', icon: Crown },
  { role: 'FINANCE_MANAGER', labelKey: 'roles.finance.label', descriptionKey: 'roles.finance.description', icon: Calculator },
  { role: 'CATALOG_MANAGER', labelKey: 'roles.catalog.label', descriptionKey: 'roles.catalog.description', icon: Archive },
];

/**
 * Renders the group and category permission matrix.
 *
 * @returns A localized, auditable role and permission editor.
 */
export function RightsPanel() {
  const { t } = useTranslation();
  const { activeGroupId } = useActiveGroup();
  const queryClient = useQueryClient();
  const membersQuery = useQuery({ queryKey: ['members', activeGroupId], queryFn: () => api.getMembers(activeGroupId) });
  const categoriesQuery = useQuery({ queryKey: ['categories', activeGroupId], queryFn: () => api.getCategories(activeGroupId) });
  const [selectedId, setSelectedId] = useState('');
  const selectedMember = membersQuery.data?.find((member) => member.id === selectedId) ?? membersQuery.data?.[0];
  const [drafts, setDrafts] = useState<Record<string, Membership>>({});
  const draft = selectedMember ? drafts[selectedMember.id] ?? selectedMember : undefined;
  const [search, setSearch] = useState('');

  const saveMutation = useMutation({
    mutationFn: () => draft ? api.updatePermissions(activeGroupId, draft.id, { roles: draft.roles, categoryPermissions: draft.categoryPermissions }, draft.etag) : Promise.reject(new Error(t('rights.noSelection'))),
    onSuccess: async () => {
      setDrafts((current) => { const next = { ...current }; if (draft) delete next[draft.id]; return next; });
      await queryClient.invalidateQueries({ queryKey: ['members', activeGroupId] });
    },
  });

  if (membersQuery.isLoading || categoriesQuery.isLoading) return <StatePanel kind="loading" />;
  if (!membersQuery.data || !categoriesQuery.data || !draft) return <StatePanel kind="error" message={t('rights.error')} />;

  const updateDraft = (update: (current: Membership) => Membership) => setDrafts((current) => ({ ...current, [draft.id]: update(current[draft.id] ?? draft) }));
  const toggleRole = (role: Exclude<GroupRole, 'MEMBER'>, checked: boolean) => updateDraft((current) => ({ ...current, roles: checked ? [...new Set([...current.roles, role])] : current.roles.filter((entry) => entry !== role) }));
  const updateCategoryPermission = (categoryId: string, field: keyof Pick<CategoryPermission, 'assignToOthers' | 'voidBookings'>, value: boolean) => updateDraft((current) => ({
    ...current,
    categoryPermissions: current.categoryPermissions.some((permission) => permission.categoryId === categoryId)
      ? current.categoryPermissions.map((permission) => permission.categoryId === categoryId ? { ...permission, [field]: value } : permission)
      : [...current.categoryPermissions, { categoryId, assignToOthers: field === 'assignToOthers' && value, voidBookings: field === 'voidBookings' && value }],
  }));
  const filteredMembers = membersQuery.data.filter((member) => member.displayName.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className={styles.layout}>
      <aside className={styles.memberRail}>
        <h2>{t('rights.teamMembers')}</h2>
        <div className={styles.search}><Search aria-hidden="true" size={20} /><TextInput aria-label={t('rights.search')} onChange={(event) => setSearch(event.target.value)} placeholder={t('rights.searchPlaceholder')} value={search} /></div>
        <div className={styles.members}>
          {filteredMembers.map((member) => (
            <button className={member.id === draft.id ? styles.selectedMember : ''} key={member.id} onClick={() => setSelectedId(member.id)} type="button">
              <Avatar name={member.displayName} />
              <span><strong>{member.displayName}</strong><small>{member.roles.includes('ADMIN') ? t('roles.admin.label') : member.roles.includes('FINANCE_MANAGER') ? t('roles.finance.label') : member.roles.includes('CATALOG_MANAGER') ? t('roles.catalog.label') : t('roles.member')}</small></span>
              {member.id === draft.id ? <ChevronRight aria-hidden="true" size={22} /> : null}
            </button>
          ))}
        </div>
      </aside>
      <section className={styles.permissions}>
        <h2>{t('rights.forMember', { name: draft.displayName })}</h2>
        <h3>{t('rights.groupRoles')}</h3>
        <div className={styles.roleList}>
          {roleRows.map(({ role, labelKey, descriptionKey, icon: Icon }) => (
            <div className={styles.role} key={role}>
              <Icon aria-hidden="true" size={34} strokeWidth={1.5} />
              <div><strong>{t(labelKey)}</strong><span>{t(descriptionKey)}</span></div>
              <Toggle checked={draft.roles.includes(role)} label={t('rights.toggleRole', { role: t(labelKey), name: draft.displayName })} onChange={(checked) => toggleRole(role, checked)} />
              <Info aria-hidden="true" className={styles.info} size={22} />
            </div>
          ))}
        </div>
        <h3 className={styles.categoryTitle}>{t('rights.categoryRights')}</h3>
        <div className={styles.permissionTable}>
          <div className={styles.tableHead}><strong>{t('common.category')}</strong><strong>{t('rights.assignOthers')}</strong><strong>{t('rights.voidBookings')}</strong><span /></div>
          {categoriesQuery.data.map((category) => {
            const permission = draft.categoryPermissions.find((entry) => entry.categoryId === category.id) ?? { categoryId: category.id, assignToOthers: false, voidBookings: false };
            return (
              <div className={styles.permissionRow} key={category.id}>
                <strong>{category.name}</strong>
                <Toggle checked={permission.assignToOthers} label={t('rights.categoryAssign', { category: category.name })} onChange={(value) => updateCategoryPermission(category.id, 'assignToOthers', value)} />
                <Toggle checked={permission.voidBookings} label={t('rights.categoryVoid', { category: category.name })} onChange={(value) => updateCategoryPermission(category.id, 'voidBookings', value)} />
                <Info aria-hidden="true" className={styles.info} size={22} />
              </div>
            );
          })}
        </div>
        <p className={styles.notice}><ShieldCheck aria-hidden="true" size={20} /> {t('rights.auditNotice')}</p>
        {saveMutation.isError ? <p className={styles.error} role="alert">{saveMutation.error.message}</p> : null}
        <div className={styles.actions}><Button onClick={() => setDrafts((current) => { const next = { ...current }; delete next[draft.id]; return next; })} variant="secondary">{t('rights.discard')}</Button><Button disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>{saveMutation.isPending ? t('rights.saving') : t('rights.save')}</Button></div>
      </section>
    </div>
  );
}
