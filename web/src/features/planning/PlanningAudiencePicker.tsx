import ShieldCheck from 'lucide-react/dist/esm/icons/shield-check';
import UsersRound from 'lucide-react/dist/esm/icons/users-round';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Membership, PlanningAudienceType, Role } from '@/api/types';
import { Avatar } from '@/components/ui/Avatar';
import { Field } from '@/components/ui/FormField';
import { MultiSelectMenu, type MultiSelectMenuOption } from '@/components/ui/MultiSelectMenu';
import styles from './Planning.module.css';

const allActiveValue = 'all-active' as const;
type AudienceOptionValue = typeof allActiveValue | `role:${string}` | `member:${string}`;
export type PlanningAudienceEditMode = 'EDITABLE' | 'PUBLISHED_ADD_ONLY' | 'SERIES_SCOPE';

interface PlanningAudiencePickerProps {
  audienceType: PlanningAudienceType;
  editMode?: PlanningAudienceEditMode;
  lockedMemberIds?: readonly string[];
  lockedRoleIds?: readonly string[];
  memberIds: readonly string[];
  members: readonly Membership[];
  onChange: (selection: { audienceType: PlanningAudienceType; memberIds: string[]; roleIds: string[] }) => void;
  roleIds: readonly string[];
  roles: readonly Role[];
}

/**
 * Renders one searchable participant selector for the complete group or a
 * combined set of roles and individual members.
 *
 * @param props - Current audience, available group identities, edit policy, locked targets, and change callback.
 * @returns A single custom multi-select with an exclusive complete-group choice.
 */
export function PlanningAudiencePicker({ audienceType, editMode = 'EDITABLE', lockedMemberIds = [], lockedRoleIds = [], memberIds, members, onChange, roleIds, roles }: PlanningAudiencePickerProps) {
  const { t } = useTranslation();
  const rolesById = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles]);
  const eligibleMembers = useMemo(() => members.filter((member) => member.status === 'ACTIVE' && member.active && !member.isTemporaryGuest), [members]);
  const membersById = useMemo(() => new Map(eligibleMembers.map((member) => [member.id, member])), [eligibleMembers]);
  const options = useMemo<MultiSelectMenuOption<AudienceOptionValue>[]>(() => [
    {
      exclusive: true,
      label: t('planning.audience.ALL_ACTIVE_MEMBERS'),
      value: allActiveValue,
      visual: <UsersRound size={19} />,
    },
    ...roles.map((role) => ({
      groupLabel: t('planning.fields.roles'),
      label: role.name,
      value: `role:${role.id}` as const,
      visual: <ShieldCheck size={19} />,
    })),
    ...roleIds.filter((roleId) => !rolesById.has(roleId)).map((roleId) => ({
      groupLabel: t('planning.fields.roles'),
      label: t('planning.form.unavailableRole'),
      value: `role:${roleId}` as const,
      visual: <ShieldCheck size={19} />,
    })),
    ...eligibleMembers.map((member) => ({
      groupLabel: t('planning.fields.members'),
      label: member.displayName,
      value: `member:${member.id}` as const,
      visual: <Avatar decorative name={member.displayName} size="small" src={member.avatarUrl} />,
    })),
    ...memberIds.filter((memberId) => !membersById.has(memberId)).map((memberId) => ({
      groupLabel: t('planning.fields.members'),
      label: t('planning.form.unavailableMember'),
      value: `member:${memberId}` as const,
      visual: <Avatar decorative name={t('common.member')} size="small" />,
    })),
  ], [eligibleMembers, memberIds, membersById, roleIds, roles, rolesById, t]);
  const targeted = audienceType !== 'ALL_ACTIVE_MEMBERS';
  const addOnly = editMode === 'PUBLISHED_ADD_ONLY';
  const values = useMemo<AudienceOptionValue[]>(() => targeted ? [
    ...roleIds.map((roleId) => `role:${roleId}` as const),
    ...memberIds.map((memberId) => `member:${memberId}` as const),
  ] : [allActiveValue], [memberIds, roleIds, targeted]);
  const lockedValues = useMemo<AudienceOptionValue[]>(() => [
    ...(addOnly && targeted ? [allActiveValue] : []),
    ...lockedRoleIds.map((roleId) => `role:${roleId}` as const),
    ...lockedMemberIds.map((memberId) => `member:${memberId}` as const),
    ...roleIds.filter((roleId) => !rolesById.has(roleId)).map((roleId) => `role:${roleId}` as const),
    ...memberIds.filter((memberId) => !membersById.has(memberId)).map((memberId) => `member:${memberId}` as const),
  ], [addOnly, lockedMemberIds, lockedRoleIds, memberIds, membersById, roleIds, rolesById, targeted]);
  const summaryTargets = useMemo(() => [
    ...roleIds.map((roleId) => ({ id: `role:${roleId}`, kind: 'role' as const, label: rolesById.get(roleId)?.name ?? t('planning.form.unavailableRole') })),
    ...memberIds.map((memberId) => ({ id: `member:${memberId}`, kind: 'member' as const, label: membersById.get(memberId)?.displayName ?? t('planning.form.unavailableMember'), member: membersById.get(memberId) })),
  ], [memberIds, membersById, roleIds, rolesById, t]);
  const summary = targeted ? <span className={styles.audienceSummary}>
    {summaryTargets.length === 0 ? <span className={styles.audiencePlaceholder}>{t('planning.form.chooseAudienceTargets')}</span> : <>
      {summaryTargets.slice(0, 2).map((target) => <span className={styles.audienceChip} key={target.id}>
        {target.kind === 'role'
          ? <ShieldCheck aria-hidden="true" size={14} />
          : <Avatar className={styles.audienceChipAvatar} decorative name={target.label} size="small" src={target.member?.avatarUrl} />}
        <span>{target.label}</span>
      </span>)}
      {summaryTargets.length > 2 ? <span className={styles.audienceOverflow}>+{summaryTargets.length - 2}</span> : null}
    </>}
  </span> : <span className={styles.audienceAllSummary}><UsersRound aria-hidden="true" size={18} /><span>{t('planning.audience.ALL_ACTIVE_MEMBERS')}</span></span>;

  return <div className={styles.audiencePicker}>
    <Field hint={t(editMode === 'PUBLISHED_ADD_ONLY' ? 'planning.form.audienceAddOnly' : editMode === 'SERIES_SCOPE' ? 'planning.form.audienceSeriesScope' : 'planning.form.audiencePickerHint')} htmlFor="planning-audience" label={t('planning.fields.audience')}>
      <MultiSelectMenu
        allLabel={t('planning.form.chooseAudienceTargets')}
        disabled={addOnly && !targeted}
        emptyLabel={t('planning.form.noAudienceTargets')}
        id="planning-audience"
        label={t('planning.fields.audience')}
        lockedValues={lockedValues}
        noResultsLabel={t('planning.form.noAudienceSearchResults')}
        onChange={(nextValues) => nextValues.includes(allActiveValue)
          ? onChange({ audienceType: 'ALL_ACTIVE_MEMBERS', memberIds: [], roleIds: [] })
          : onChange({
            audienceType: 'SELECTED_TARGETS',
            roleIds: nextValues.filter((value) => value.startsWith('role:')).map((value) => value.slice('role:'.length)),
            memberIds: nextValues.filter((value) => value.startsWith('member:')).map((value) => value.slice('member:'.length)),
          })}
        options={options}
        searchLabel={t('planning.form.audienceSearch')}
        summary={summary}
        values={values}
      />
    </Field>
  </div>;
}
