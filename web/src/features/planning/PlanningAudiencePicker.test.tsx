import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Membership, PlanningAudienceType, Role } from '@/api/types';
import i18n from '@/i18n';
import { PlanningAudiencePicker, type PlanningAudienceEditMode } from './PlanningAudiencePicker';

const roles: Role[] = [{ id: 'role-operations', name: 'Operations', grants: [], version: 1, memberCount: 2, pendingInvitationCount: 0 }];
const members: Membership[] = [{
  id: 'member-alex',
  userId: 'user-alex',
  displayName: 'Alex Example',
  email: 'alex@example.test',
  initials: 'AE',
  avatarUrl: '/avatars/alex.png',
  isTemporaryGuest: false,
  roles: ['MEMBER'],
  groupPermissions: [],
  categoryPermissions: [],
  themeOverride: null,
  status: 'ACTIVE',
  active: true,
}];

interface AudienceSelection {
  audienceType: PlanningAudienceType;
  memberIds: string[];
  roleIds: string[];
}

function AudienceHarness({ editMode = 'EDITABLE', initialSelection = { audienceType: 'ALL_ACTIVE_MEMBERS', memberIds: [], roleIds: [] }, onSelection }: { editMode?: PlanningAudienceEditMode; initialSelection?: AudienceSelection; onSelection: (selection: AudienceSelection) => void }) {
  const [selection, setSelection] = useState<AudienceSelection>(initialSelection);
  return <PlanningAudiencePicker
    audienceType={selection.audienceType}
    editMode={editMode}
    lockedMemberIds={editMode === 'PUBLISHED_ADD_ONLY' ? initialSelection.memberIds : []}
    lockedRoleIds={editMode === 'PUBLISHED_ADD_ONLY' ? initialSelection.roleIds : []}
    memberIds={selection.memberIds}
    members={members}
    onChange={(next) => { setSelection(next); onSelection(next); }}
    roleIds={selection.roleIds}
    roles={roles}
  />;
}

describe('PlanningAudiencePicker', () => {
  it('combines complete-group, role, and individual member choices in one grouped menu', async () => {
    const user = userEvent.setup();
    const onSelection = vi.fn();
    render(<AudienceHarness onSelection={onSelection} />);

    const audienceControl = screen.getByLabelText(i18n.t('planning.fields.audience'));
    expect(audienceControl).toHaveRole('button');
    expect(audienceControl).toHaveTextContent(i18n.t('planning.audience.ALL_ACTIVE_MEMBERS'));
    await user.click(audienceControl);

    expect(screen.getByText(i18n.t('planning.fields.roles'))).toBeVisible();
    expect(screen.getByText(i18n.t('planning.fields.members'))).toBeVisible();
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/avatars/alex.png');
    expect(screen.getByRole('checkbox', { name: i18n.t('planning.audience.ALL_ACTIVE_MEMBERS') })).toBeChecked();

    await user.click(screen.getByRole('checkbox', { name: 'Operations' }));
    expect(screen.getByRole('checkbox', { name: i18n.t('planning.audience.ALL_ACTIVE_MEMBERS') })).not.toBeChecked();
    expect(onSelection).toHaveBeenLastCalledWith({ audienceType: 'SELECTED_TARGETS', memberIds: [], roleIds: ['role-operations'] });
    await user.click(screen.getByRole('checkbox', { name: 'Alex Example' }));

    expect(onSelection).toHaveBeenLastCalledWith({ audienceType: 'SELECTED_TARGETS', memberIds: ['member-alex'], roleIds: ['role-operations'] });
    expect(audienceControl).toHaveTextContent('Operations');
    expect(audienceControl).toHaveTextContent('Alex Example');

    await user.click(screen.getByRole('checkbox', { name: i18n.t('planning.audience.ALL_ACTIVE_MEMBERS') }));
    expect(onSelection).toHaveBeenLastCalledWith({ audienceType: 'ALL_ACTIVE_MEMBERS', memberIds: [], roleIds: [] });
  });

  it('keeps published targets locked while allowing additional individual choices', async () => {
    const user = userEvent.setup();
    render(<AudienceHarness
      initialSelection={{ audienceType: 'SELECTED_TARGETS', memberIds: [], roleIds: ['role-operations'] }}
      editMode="PUBLISHED_ADD_ONLY"
      onSelection={vi.fn()}
    />);

    await user.click(screen.getByLabelText(i18n.t('planning.fields.audience')));

    expect(screen.getByRole('checkbox', { name: i18n.t('planning.audience.ALL_ACTIVE_MEMBERS') })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Operations' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Operations' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Alex Example' })).toBeEnabled();
  });

  it('allows target removal when a published series will be saved with a series scope', async () => {
    const user = userEvent.setup();
    const onSelection = vi.fn();
    render(<AudienceHarness
      editMode="SERIES_SCOPE"
      initialSelection={{ audienceType: 'SELECTED_TARGETS', memberIds: [], roleIds: ['role-operations'] }}
      onSelection={onSelection}
    />);

    await user.click(screen.getByLabelText(i18n.t('planning.fields.audience')));
    const role = screen.getByRole('checkbox', { name: 'Operations' });
    expect(role).toBeEnabled();
    await user.click(role);

    expect(onSelection).toHaveBeenLastCalledWith({ audienceType: 'SELECTED_TARGETS', memberIds: [], roleIds: [] });
  });
});
