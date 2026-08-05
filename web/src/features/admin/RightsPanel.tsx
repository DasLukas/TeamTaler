import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right';
import Search from 'lucide-react/dist/esm/icons/search';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { Membership, PermissionUpdate } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/FormField';
import { StatePanel } from '@/components/ui/StatePanel';
import { PermissionEditor } from './PermissionEditor';
import styles from './RightsPanel.module.css';

/** Inputs used to select a member from the parent administration workspace. */
export interface RightsPanelProps {
  selectedMemberId?: string;
  onSelectedMemberChange?: (membershipId: string) => void;
}

/**
 * Renders the active-member permission workspace.
 *
 * @param props - Optional controlled member selection from the members tab.
 * @returns A localized, auditable role and permission editor.
 */
export function RightsPanel({ selectedMemberId, onSelectedMemberChange }: RightsPanelProps) {
  const { t } = useTranslation();
  const { activeGroupId } = useActiveGroup();
  const queryClient = useQueryClient();
  const membersQuery = useQuery({ queryKey: ['members', activeGroupId], queryFn: () => api.getMembers(activeGroupId) });
  const categoriesQuery = useQuery({ queryKey: ['categories', activeGroupId], queryFn: () => api.getCategories(activeGroupId) });
  const [internalSelectedId, setInternalSelectedId] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Membership>>({});
  const [search, setSearch] = useState('');
  const activeMembers = membersQuery.data?.filter((member) => member.active) ?? [];
  const effectiveSelectedId = selectedMemberId ?? internalSelectedId;
  const selectedMember = activeMembers.find((member) => member.id === effectiveSelectedId) ?? activeMembers[0];
  const draft = selectedMember ? drafts[selectedMember.id] ?? selectedMember : undefined;

  const saveMutation = useMutation({
    mutationFn: () => draft
      ? api.updatePermissions(activeGroupId, draft.id, { roles: draft.roles, categoryPermissions: draft.categoryPermissions }, draft.etag)
      : Promise.reject(new Error(t('rights.noSelection'))),
    onSuccess: async () => {
      setDrafts((current) => {
        const next = { ...current };
        if (draft) delete next[draft.id];
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ['members', activeGroupId] });
    },
  });

  if (membersQuery.isLoading || categoriesQuery.isLoading) return <StatePanel kind="loading" />;
  if (!membersQuery.data || !categoriesQuery.data) return <StatePanel kind="error" message={t('rights.error')} />;
  if (!draft) return <StatePanel kind="empty" message={t('rights.noActiveMembers')} />;

  const chooseMember = (membershipId: string) => {
    setInternalSelectedId(membershipId);
    onSelectedMemberChange?.(membershipId);
  };
  const updateDraft = (permissions: PermissionUpdate) => setDrafts((current) => ({
    ...current,
    [draft.id]: { ...draft, roles: permissions.roles, categoryPermissions: permissions.categoryPermissions },
  }));
  const filteredMembers = activeMembers.filter((member) => member.displayName.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className={styles.layout}>
      <aside className={styles.memberRail}>
        <h2>{t('rights.teamMembers')}</h2>
        <div className={styles.search}><Search aria-hidden="true" size={20} /><TextInput aria-label={t('rights.search')} onChange={(event) => setSearch(event.target.value)} placeholder={t('rights.searchPlaceholder')} value={search} /></div>
        <div className={styles.members}>
          {filteredMembers.map((member) => (
            <button className={member.id === draft.id ? styles.selectedMember : ''} key={member.id} onClick={() => chooseMember(member.id)} type="button">
              <Avatar name={member.displayName} src={member.avatarUrl} />
              <span><strong>{member.displayName}</strong><small>{member.roles.includes('ADMIN') ? t('roles.admin.label') : member.roles.includes('FINANCE_MANAGER') ? t('roles.finance.label') : member.roles.includes('CATALOG_MANAGER') ? t('roles.catalog.label') : t('roles.member')}</small></span>
              {member.id === draft.id ? <ChevronRight aria-hidden="true" size={22} /> : null}
            </button>
          ))}
        </div>
      </aside>
      <section className={styles.permissions}>
        <h2>{t('rights.forMember', { name: draft.displayName })}</h2>
        <PermissionEditor
          categories={categoriesQuery.data}
          onChange={updateDraft}
          showAuditNotice
          subjectName={draft.displayName}
          value={{ roles: draft.roles, categoryPermissions: draft.categoryPermissions }}
        />
        {saveMutation.isError ? <p className={styles.error} role="alert">{saveMutation.error.message}</p> : null}
        <div className={styles.actions}>
          <Button onClick={() => setDrafts((current) => { const next = { ...current }; delete next[draft.id]; return next; })} variant="secondary">{t('rights.discard')}</Button>
          <Button disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>{saveMutation.isPending ? t('rights.saving') : t('rights.save')}</Button>
        </div>
      </section>
    </div>
  );
}
