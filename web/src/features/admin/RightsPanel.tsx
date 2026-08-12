import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Copy from 'lucide-react/dist/esm/icons/copy';
import LockKeyhole from 'lucide-react/dist/esm/icons/lock-keyhole';
import Plus from 'lucide-react/dist/esm/icons/plus';
import Star from 'lucide-react/dist/esm/icons/star';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import UsersRound from 'lucide-react/dist/esm/icons/users-round';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { PermissionDefinition, PermissionKey, Role, RoleInput } from '@/api/types';
import { can } from '@/app/permissions';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { StatePanel } from '@/components/ui/StatePanel';
import { PermissionEditor } from './PermissionEditor';
import { roleDisplayDescription, roleDisplayName } from './roleDisplayName';
import styles from './RightsPanel.module.css';

interface RoleEditorProps {
  groupId: string;
  definitions: PermissionDefinition[];
  role?: Role;
  initial?: RoleInput;
  canManageProtectedRoles: boolean;
  onDuplicate?: () => void;
  onSaved: (role: Role) => void;
  onDeleted: () => void;
  isDefaultRole?: boolean;
}

const ADMIN_CORE_PERMISSIONS: readonly PermissionKey[] = ['GROUP_ADMINISTRATION', 'MEMBER_MANAGEMENT', 'ROLE_MANAGEMENT'];

function RoleEditor({ groupId, definitions, role, initial, canManageProtectedRoles, onDuplicate, onSaved, onDeleted, isDefaultRole = false }: RoleEditorProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(initial?.name ?? role?.name ?? '');
  const baselineDescription = initial?.description ?? (role ? roleDisplayDescription(role) : '');
  const [description, setDescription] = useState(baselineDescription);
  const [grants, setGrants] = useState(initial?.grants ?? role?.grants ?? []);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const isReservedAdmin = role?.presetKey === 'GROUP_ADMINISTRATOR';
  const isNameLocked = role?.nameLocked ?? isReservedAdmin;
  const isDeletable = role?.deletable ?? !isReservedAdmin;
  const protectedChangeBlocked = !canManageProtectedRoles && isReservedAdmin;
  const protectedPermissions = isReservedAdmin ? ADMIN_CORE_PERMISSIONS : canManageProtectedRoles ? [] : ['GROUP_ADMINISTRATION'] as const;
  const assignmentCount = (role?.memberCount ?? 0) + (role?.pendingInvitationCount ?? 0);
  const changed = name.trim() !== (role?.name ?? initial?.name ?? '')
    || description.trim() !== baselineDescription
    || JSON.stringify(grants.map((grant) => grant.permission).sort()) !== JSON.stringify((role?.grants ?? initial?.grants ?? []).map((grant) => grant.permission).sort());

  const invalidateRoleData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['roles', groupId] }),
      queryClient.invalidateQueries({ queryKey: ['role-assignments', groupId] }),
      queryClient.invalidateQueries({ queryKey: ['members', groupId] }),
      queryClient.invalidateQueries({ queryKey: ['session'] }),
    ]);
  };
  const saveMutation = useMutation({
    mutationFn: () => {
      const normalizedDescription = description.trim();
      const persistedDescription = role && normalizedDescription === baselineDescription ? role.description : normalizedDescription || undefined;
      const input: RoleInput = { name: name.trim(), description: persistedDescription, grants };
      return role ? api.updateRole(groupId, role.id, input, role.version) : api.createRole(groupId, input);
    },
    onSuccess: async (saved) => {
      await invalidateRoleData();
      onSaved(saved);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: () => role ? api.deleteRole(groupId, role.id, role.version) : Promise.reject(new Error(t('roleManagement.noRoleSelected'))),
    onSuccess: async () => {
      await invalidateRoleData();
      onDeleted();
    },
  });

  return (
    <section className={styles.roleEditor}>
      <header className={styles.roleEditorHeader}>
        <div>
          <span className={styles.eyebrow}>{role ? t('roleManagement.editRole') : t('roleManagement.newRole')}</span>
          <div className={styles.roleEditorTitleRow}>
            <h2>{role ? roleDisplayName(role) : initial?.name || t('roleManagement.newRole')}</h2>
            {onDuplicate ? <Button leadingIcon={<Copy size={16} />} onClick={onDuplicate} size="small" variant="ghost">{t('roleManagement.duplicate')}</Button> : null}
          </div>
        </div>
      </header>
      <div className={styles.roleFields}>
        <Field htmlFor="role-name" label={t('roleManagement.name')}>
          <TextInput disabled={isNameLocked || protectedChangeBlocked} id="role-name" maxLength={120} onChange={(event) => setName(event.target.value)} required value={role && isNameLocked ? roleDisplayName(role) : name} />
        </Field>
        <Field htmlFor="role-description" label={t('common.description')}>
          <TextInput disabled={protectedChangeBlocked} id="role-description" maxLength={500} onChange={(event) => setDescription(event.target.value)} value={description} />
        </Field>
      </div>
      {protectedChangeBlocked ? <p className={styles.warning} role="note">{t('roleManagement.protectedChangeBlocked')}</p> : null}
      <PermissionEditor definitions={definitions} disabled={protectedChangeBlocked} onChange={setGrants} protectedPermissions={protectedPermissions} value={grants} />
      {saveMutation.isError ? <p className={styles.error} role="alert">{saveMutation.error.message}</p> : null}
      {deleteMutation.isError ? <p className={styles.error} role="alert">{deleteMutation.error.message}</p> : null}
      {confirmingDelete ? <p className={styles.warning} role="alert">{t('roleManagement.deleteConfirmation', { name: role?.name })}</p> : null}
      <div className={styles.editorActions}>
        {role && isDeletable ? (
          confirmingDelete
            ? <><Button onClick={() => setConfirmingDelete(false)} variant="secondary">{t('common.cancel')}</Button><Button disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate()} variant="danger">{t('roleManagement.confirmDelete')}</Button></>
            : <Button disabled={assignmentCount > 0 || isDefaultRole} leadingIcon={<Trash2 size={17} />} onClick={() => setConfirmingDelete(true)} title={isDefaultRole ? t('roleManagement.defaultRoleDeleteBlocked') : undefined} variant="ghost">{t('common.delete')}</Button>
        ) : <span />}
        <Button disabled={!name.trim() || !changed || saveMutation.isPending || protectedChangeBlocked} onClick={() => saveMutation.mutate()}>{saveMutation.isPending ? t('roleManagement.saving') : t('common.save')}</Button>
      </div>
    </section>
  );
}

/**
 * Renders group-owned role definitions and permission grants.
 *
 * The parent guard mounts this component only for role administrators. Member
 * and invitation assignments are managed in the members workspace.
 *
 * @returns Role CRUD and grant editing.
 */
export function RightsPanel() {
  const { t } = useTranslation();
  const { activeGroupId, activeGroup } = useActiveGroup();
  const grants = activeGroup.membership?.effectiveGrants;
  const canManageGroup = can(grants, 'GROUP_ADMINISTRATION');
  const canManageRoles = can(grants, 'ROLE_MANAGEMENT');
  const rolesQuery = useQuery({ queryKey: ['roles', activeGroupId], queryFn: () => api.getRoles(activeGroupId) });
  const definitionsQuery = useQuery({ queryKey: ['permission-definitions'], queryFn: () => api.getPermissionDefinitions(), enabled: canManageRoles, staleTime: Number.POSITIVE_INFINITY });
  const settingsQuery = useQuery({ queryKey: ['group-settings', activeGroupId], queryFn: () => api.getGroupSettings(activeGroupId), enabled: canManageGroup });
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [newRoleSeed, setNewRoleSeed] = useState<RoleInput | null>(null);
  const roles = rolesQuery.data ?? [];
  const selectedRole = roles.find((role) => role.id === selectedRoleId) ?? roles[0];

  if (rolesQuery.isLoading || definitionsQuery.isLoading || (canManageGroup && settingsQuery.isLoading)) return <StatePanel kind="loading" />;
  if (!rolesQuery.data || !definitionsQuery.data || (canManageGroup && !settingsQuery.data)) return <StatePanel kind="error" message={t('roleManagement.loadError')} />;

  const startCreate = (seed?: Role) => {
    setSelectedRoleId('');
    setNewRoleSeed({
      name: seed ? t('roleManagement.copyName', { name: roleDisplayName(seed) }) : '',
      description: seed ? roleDisplayDescription(seed) : undefined,
      grants: seed?.grants.filter((grant) => canManageGroup || grant.permission !== 'GROUP_ADMINISTRATION') ?? [],
    });
  };
  const selectRole = (roleId: string) => {
    setNewRoleSeed(null);
    setSelectedRoleId(roleId);
  };

  return (
    <div className={styles.workspace}>
      <section className={styles.rolesWorkspace}>
        <aside className={styles.roleRail}>
          <div className={styles.roleRailHeader}><div><span>{t('roleManagement.title')}</span><strong>{t('roleManagement.roleCount', { count: roles.length })}</strong></div><Button aria-label={t('roleManagement.create')} leadingIcon={<Plus size={17} />} onClick={() => startCreate()} size="small">{t('roleManagement.create')}</Button></div>
          <div className={styles.roleCards}>
            {roles.map((role) => {
              const isDefaultRole = settingsQuery.data?.defaultRoleId === role.id;
              return <button className={!newRoleSeed && role.id === selectedRole?.id ? styles.selectedRole : undefined} key={role.id} onClick={() => selectRole(role.id)} type="button"><span><UsersRound aria-hidden="true" size={21} /><strong title={roleDisplayName(role)}>{roleDisplayName(role)}</strong>{isDefaultRole ? <span aria-label={t('roleManagement.defaultRoleIndicator')} className={styles.defaultRoleIcon} role="img" title={t('roleManagement.defaultRoleIndicator')}><Star aria-hidden="true" fill="currentColor" size={16} /></span> : null}{role.presetKey === 'GROUP_ADMINISTRATOR' ? <LockKeyhole aria-label={t('roleManagement.preset')} size={15} /> : null}</span><small>{t('roleManagement.assignmentCount', { members: role.memberCount, invitations: role.pendingInvitationCount })}</small></button>;
            })}
          </div>
        </aside>
        <div className={styles.roleDetail}>
          {newRoleSeed ? (
            <RoleEditor canManageProtectedRoles={canManageGroup} definitions={definitionsQuery.data ?? []} groupId={activeGroupId} initial={newRoleSeed} key={`new-${newRoleSeed.name}`} onDeleted={() => undefined} onSaved={(saved) => { setNewRoleSeed(null); setSelectedRoleId(saved.id); }} />
          ) : selectedRole ? (
            <RoleEditor canManageProtectedRoles={canManageGroup} definitions={definitionsQuery.data ?? []} groupId={activeGroupId} isDefaultRole={settingsQuery.data?.defaultRoleId === selectedRole.id} key={`${selectedRole.id}-${selectedRole.version}`} onDeleted={() => setSelectedRoleId('')} onDuplicate={() => startCreate(selectedRole)} onSaved={(saved) => setSelectedRoleId(saved.id)} role={selectedRole} />
          ) : <StatePanel actionLabel={t('roleManagement.create')} kind="empty" message={t('roleManagement.noRoles')} onAction={() => startCreate()} />}
        </div>
      </section>
    </div>
  );
}
