import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionDefinition, PermissionGrant, Role } from '@/api/types';
import i18n from '@/i18n';
import { PermissionEditor } from './PermissionEditor';
import { RoleMultiSelect } from './RoleMultiSelect';
import { RoleSelectionList } from './RoleSelectionList';

const definitions: PermissionDefinition[] = [
  { key: 'VOID_OWN_BOOKING' },
  { key: 'VOID_ANY_BOOKING', impliedPermissions: ['VOID_OWN_BOOKING', 'VIEW_ALL_BOOKING_ACTIVITY'] },
  { key: 'VIEW_ALL_BOOKING_ACTIVITY' },
];

function PermissionHarness() {
  const [value, setValue] = useState<PermissionGrant[]>([]);
  return <PermissionEditor definitions={definitions} onChange={setValue} value={value} />;
}

const roles: Role[] = [
  { id: 'role-admin', presetKey: 'GROUP_ADMINISTRATOR', name: 'Group administrator', grants: ['GROUP_ADMINISTRATION', 'MEMBER_MANAGEMENT', 'ROLE_MANAGEMENT'].map((permission) => ({ permission, scope: { type: 'GROUP' as const } })) as Role['grants'], version: 1, memberCount: 1, pendingInvitationCount: 0 },
  { id: 'role-member', presetKey: 'MEMBER', name: 'Member', grants: [], version: 1, memberCount: 1, pendingInvitationCount: 0 },
  { id: 'role-finance', name: 'Finance', grants: [{ permission: 'FINANCE_MANAGEMENT', scope: { type: 'GROUP' } }], version: 1, memberCount: 0, pendingInvitationCount: 0 },
  { id: 'role-admin-custom', name: 'Administrative custom role', grants: [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }], version: 1, memberCount: 0, pendingInvitationCount: 0 },
];

describe('dynamic role controls', () => {
  it('shows calculated VOID_ANY_BOOKING implications without persisting duplicate grants', async () => {
    const user = userEvent.setup();
    render(<PermissionHarness />);

    await user.click(screen.getByRole('switch', { name: i18n.t('roleManagement.togglePermission', { permission: i18n.t('permissions.VOID_ANY_BOOKING.label') }) }));

    expect(screen.getAllByText(i18n.t('roleManagement.impliedPermission'))).toHaveLength(2);
    expect(screen.getByRole('switch', { name: i18n.t('roleManagement.togglePermission', { permission: i18n.t('permissions.VOID_OWN_BOOKING.label') }) })).toBeDisabled();
    expect(screen.getByRole('switch', { name: i18n.t('roleManagement.togglePermission', { permission: i18n.t('permissions.VIEW_ALL_BOOKING_ACTIVITY.label') }) })).toBeDisabled();
  });

  it('allows assigning starter roles while protecting administrative roles', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RoleMultiSelect canAssignRoles label="Roles" onChange={onChange} roleIds={[]} roles={roles} />);

    expect(screen.getByRole('checkbox', { name: /Mitglied/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Mitglied/i })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: /Administrative custom role/i })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Gruppenadministrator/i })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /Finance/i }));

    expect(onChange).toHaveBeenCalledWith(['role-finance']);
  });

  it('does not let group-only administrators assign roles', () => {
    const onChange = vi.fn();
    render(<RoleMultiSelect canManageGroup label="Roles" onChange={onChange} roleIds={['role-member']} roles={roles} />);

    const reservedAdministrator = screen.getByRole('checkbox', { name: /Gruppenadministrator/i });
    expect(reservedAdministrator).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Finance/i })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Administrative custom role/i })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('lets member and group administrators transfer protected roles', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RoleMultiSelect canAssignRoles canManageGroup label="Roles" onChange={onChange} roleIds={['role-member']} roles={roles} />);

    const reservedAdministrator = screen.getByRole('checkbox', { name: /Gruppenadministrator/i });
    expect(reservedAdministrator).toBeEnabled();
    await user.click(reservedAdministrator);

    expect(onChange).toHaveBeenCalledWith(['role-admin', 'role-member']);
  });

  it('keeps the last administrator role locked without showing a redundant label', () => {
    render(
      <RoleSelectionList
        canManageGroup
        label="Roles"
        lockedRoleIds={['role-admin']}
        onChange={vi.fn()}
        roleIds={['role-admin']}
        roles={roles}
      />,
    );

    expect(screen.getByRole('checkbox', { name: /Gruppenadministrator/i })).toBeDisabled();
    expect(screen.queryByText('Letzter Administrator')).not.toBeInTheDocument();
  });
});
