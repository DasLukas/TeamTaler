import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvitationImportResult, InvitationMetadata, InvitationUpdateInput, Membership, Role, Session } from '@/api/types';
import { ActiveGroupContext } from '@/app/active-group-context';
import i18n from '@/i18n';
import { MembersPanel } from './MembersPanel';

const apiMock = vi.hoisted(() => ({
  getMembers: vi.fn(),
  getCategories: vi.fn(),
  getRoles: vi.fn(),
  getGroupSettings: vi.fn(),
  updateGroupSettings: vi.fn(),
  createInvitation: vi.fn(),
  updateInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
  resendInvitationEmail: vi.fn(),
  archiveMember: vi.fn(),
  reactivateMember: vi.fn(),
  permanentlyDeleteMember: vi.fn(),
  renameMember: vi.fn(),
  createTemporaryGuestClaimInvitation: vi.fn(),
  importInvitations: vi.fn(),
  getInvitations: vi.fn(),
  retryInvitationEmail: vi.fn(),
  updateMemberRoles: vi.fn(),
  updateInvitationRoles: vi.fn(),
  getPublicJoinLink: vi.fn(),
  updatePublicJoinLink: vi.fn(),
  rotatePublicJoinLink: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  api: apiMock,
  ApiError: class MockApiError extends Error {
    problem: { status: number };
    constructor(status: number) {
      super(String(status));
      this.problem = { status };
    }
  },
}));

const session: Session = {
  user: { id: 'user-admin', displayName: 'Admin', email: 'admin@example.test' },
  groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: 'member-admin', roleIds: ['role-admin', 'role-member'], effectiveGrants: [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }, { permission: 'MEMBER_MANAGEMENT', scope: { type: 'GROUP' } }, { permission: 'ROLE_MANAGEMENT', scope: { type: 'GROUP' } }], roles: ['ADMIN', 'MEMBER'], groupPermissions: [] } }],
  activeGroupId: 'group-a',
  defaultGroupId: null,
  systemRoles: [],
};

const members: Membership[] = [{
  id: 'member-admin',
  userId: 'user-admin',
  displayName: 'Admin',
  email: 'admin@example.test',
  initials: 'A',
  isTemporaryGuest: false,
  roles: ['ADMIN', 'MEMBER'],
  roleIds: ['role-admin', 'role-member'],
  roleAssignmentsVersion: 1,
  groupPermissions: [],
  categoryPermissions: [],
  status: 'ACTIVE',
  active: true,
}];

const temporaryGuest: Membership = {
  ...members[0],
  id: 'member-guest',
  userId: 'user-guest-credentialless',
  displayName: 'Managed Guest',
  email: null,
  initials: 'MG',
  isTemporaryGuest: true,
  roles: ['MEMBER'],
  roleIds: [],
  effectiveGrants: [],
};

const roles: Role[] = [
  { id: 'role-admin', presetKey: 'GROUP_ADMINISTRATOR', name: 'Gruppenadministrator', grants: [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }, { permission: 'MEMBER_MANAGEMENT', scope: { type: 'GROUP' } }, { permission: 'ROLE_MANAGEMENT', scope: { type: 'GROUP' } }], version: 1, memberCount: 1, pendingInvitationCount: 0 },
  { id: 'role-member', name: 'Mitglied', grants: [{ permission: 'VOID_OWN_BOOKING', scope: { type: 'GROUP' } }], version: 1, memberCount: 1, pendingInvitationCount: 1 },
  { id: 'role-finance', name: 'Finanzverwaltung', grants: [{ permission: 'FINANCE_MANAGEMENT', scope: { type: 'GROUP' } }], version: 1, memberCount: 0, pendingInvitationCount: 0 },
];

const importResult: InvitationImportResult = {
  summary: { totalRows: 4, created: 1, invalid: 1, skipped: 2 },
  rows: [
    { row: 2, email: 'new@example.test', displayName: 'New Member', invitationId: 'invitation-new', invitationStatus: 'CREATED', emailDeliveryStatus: 'PENDING' },
    { row: 3, email: 'invalid-address', displayName: 'Invalid Member', invitationStatus: 'INVALID', emailDeliveryStatus: 'NOT_REQUESTED', code: 'invalid_email' },
    { row: 4, email: 'admin@example.test', displayName: 'Admin', invitationStatus: 'SKIPPED_ALREADY_MEMBER', emailDeliveryStatus: 'NOT_REQUESTED' },
    { row: 5, email: 'invited@example.test', displayName: 'Invited Member', invitationId: 'invitation-existing', invitationStatus: 'SKIPPED_ALREADY_INVITED', emailDeliveryStatus: 'NOT_REQUESTED' },
  ],
};

const invitationMetadata: InvitationMetadata[] = [{
  id: 'invitation-new',
  email: 'new@example.test',
  displayName: 'New Member',
  roles: ['MEMBER'],
  roleIds: ['role-member'],
  roleAssignmentsVersion: 3,
  groupPermissions: [],
  categoryPermissions: [],
  expiresAt: '2026-08-11T12:00:00Z',
  emailDeliveryStatus: 'SENT',
  emailSentAt: '2026-08-04T12:01:00Z',
}];

/**
 * Renders the members panel with its active-group and query dependencies.
 *
 * @returns The query client used by the rendered panel.
 */
function renderMembers(activeSession: Session = session): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ActiveGroupContext.Provider value={{ session: activeSession, activeGroup: activeSession.groups[0], activeGroupId: 'group-a', setActiveGroupId: vi.fn() }}>
        {children}
      </ActiveGroupContext.Provider>
    </QueryClientProvider>
  );
  render(<MembersPanel />, { wrapper });
  return queryClient;
}

describe('MembersPanel invitations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getMembers.mockResolvedValue(members);
    apiMock.getRoles.mockResolvedValue(roles);
    apiMock.getGroupSettings.mockResolvedValue({ notificationEmailsEnabled: false, notificationEmailDeliveryAvailable: true, defaultRoleId: 'role-member' });
    apiMock.updateGroupSettings.mockResolvedValue({ notificationEmailsEnabled: false, notificationEmailDeliveryAvailable: true, defaultRoleId: 'role-finance' });
    apiMock.getPublicJoinLink.mockResolvedValue({ enabled: false, expired: false, expiresAt: null, version: 0, emailVerificationAvailable: true });
  apiMock.getCategories.mockResolvedValue([]);
    apiMock.createInvitation.mockResolvedValue({
      id: 'invitation-manual',
      email: 'manual@example.test',
      roles: ['MEMBER'],
      groupPermissions: [],
      categoryPermissions: [],
      roleAssignmentsVersion: 1,
      expiresAt: '2026-08-11T12:00:00Z',
      acceptUrl: 'https://teamtaler.example/invite#token=manual-token',
      emailDeliveryStatus: 'PENDING',
    });
    apiMock.importInvitations.mockResolvedValue(importResult);
    apiMock.getInvitations.mockResolvedValue(invitationMetadata);
    apiMock.retryInvitationEmail.mockResolvedValue({ invitationId: 'invitation-new', emailDeliveryStatus: 'PENDING' });
  apiMock.updateInvitation.mockImplementation((_groupId: string, _invitationId: string, input: InvitationUpdateInput) => Promise.resolve({ ...invitationMetadata[0], ...input }));
  apiMock.revokeInvitation.mockResolvedValue(undefined);
  apiMock.resendInvitationEmail.mockResolvedValue({ invitationId: 'invitation-new', emailDeliveryStatus: 'PENDING', expiresAt: '2026-08-12T12:00:00Z', acceptUrl: 'https://teamtaler.example/invite#token=rotated' });
  apiMock.archiveMember.mockResolvedValue(undefined);
  apiMock.reactivateMember.mockImplementation((_groupId: string, _membershipId: string, input: { displayName?: string; roleIds: string[] }) => Promise.resolve({ ...members[0], displayName: input.displayName ?? members[0].displayName, roleIds: input.roleIds, status: 'ACTIVE', active: true }));
  apiMock.permanentlyDeleteMember.mockResolvedValue(undefined);
  apiMock.renameMember.mockImplementation((_groupId: string, _membershipId: string, displayName: string) => Promise.resolve({ ...members[0], displayName }));
  apiMock.createTemporaryGuestClaimInvitation.mockResolvedValue({
    id: 'invitation-claim',
    email: 'guest@example.test',
    displayName: 'Managed Guest',
    roles: ['MEMBER'],
    roleIds: ['role-member'],
    roleAssignmentsVersion: 1,
    groupPermissions: [],
    categoryPermissions: [],
    expiresAt: '2026-08-11T12:00:00Z',
    acceptUrl: 'https://teamtaler.example/invite#token=claim-token',
    emailDeliveryStatus: 'PENDING',
    targetMembershipId: 'member-guest',
  });
  apiMock.updateMemberRoles.mockResolvedValue({ subjectType: 'MEMBERSHIP', subjectId: 'member-admin', roleIds: ['role-admin', 'role-member', 'role-finance'], version: 2 });
  apiMock.updateInvitationRoles.mockResolvedValue({ subjectType: 'INVITATION', subjectId: 'invitation-new', roleIds: ['role-member', 'role-finance'], version: 4 });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:member-import-template') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  });

  it('omits the neutral email-delivery badge from manual-link invitations', async () => {
    apiMock.getInvitations.mockResolvedValue([{ ...invitationMetadata[0], emailDeliveryStatus: 'NOT_REQUESTED' }]);
    renderMembers();

    expect(await screen.findByText('new@example.test')).toBeVisible();
    expect(screen.queryByText(i18n.t('members.csvImport.deliveryStatus.notRequested'))).not.toBeInTheDocument();
  });

  it('keeps every member collection in a semantic table within a focusable scroll region', async () => {
    apiMock.getMembers.mockResolvedValue([members[0], {
      ...members[0],
      id: 'member-archived',
      userId: 'user-archived',
      displayName: 'Archived Member',
      email: 'archived@example.test',
      status: 'ARCHIVED',
      active: false,
    }]);
    renderMembers();

    const collections = [
      { name: i18n.t('members.openInvitations'), columns: 6 },
      { name: i18n.t('members.activeMembers'), columns: 4 },
      { name: i18n.t('members.archivedMembers'), columns: 3 },
    ];
    await screen.findByText('new@example.test');

    for (const collection of collections) {
      const region = screen.getByRole('region', { name: collection.name });
      expect(region).toHaveAttribute('tabindex', '0');
      const table = within(region).getByRole('table');
      const headers = within(table).getAllByRole('columnheader');
      expect(headers).toHaveLength(collection.columns);
      headers.forEach((header) => expect(header).toHaveAttribute('scope', 'col'));
      expect(within(table).getAllByRole('cell')).toHaveLength(collection.columns);
    }
  });

  it('keeps relevant email-delivery badges visible', async () => {
    renderMembers();

    expect(await screen.findByText(i18n.t('members.csvImport.deliveryStatus.sent'))).toBeVisible();
  });

  it('loads public join-link state only after an administrator opens its dialog', async () => {
    const user = userEvent.setup();
    renderMembers();

    expect(apiMock.getPublicJoinLink).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: i18n.t('publicJoin.action') }));

    expect(await screen.findByRole('dialog', { name: i18n.t('publicJoin.adminTitle') })).toBeVisible();
    await waitFor(() => expect(apiMock.getPublicJoinLink).toHaveBeenCalledWith('group-a'));
  });

  it('does not render the default-role setting in member management', async () => {
    renderMembers();

    expect(await screen.findByRole('heading', { name: i18n.t('members.openInvitations') })).toBeVisible();
    expect(screen.queryByLabelText(i18n.t('behaviorSettings.defaultRoleFieldLabel'))).not.toBeInTheDocument();
  });

  it('shows invitation names before email addresses in the desktop table', async () => {
    renderMembers();

    const invitationsSection = (await screen.findByRole('heading', { name: i18n.t('members.openInvitations') })).closest('section') as HTMLElement;
    const headers = within(invitationsSection).getAllByRole('columnheader');
    expect(headers[0]).toHaveTextContent(i18n.t('common.name'));
    expect(headers[1]).toHaveTextContent(i18n.t('members.email'));

    const invitationRow = within(invitationsSection).getByRole('row', { name: /New Member new@example\.test/ });
    const cells = within(invitationRow).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent('New Member');
    expect(cells[1]).toHaveTextContent('new@example.test');
  });

  it('keeps compact header actions explicitly labelled for assistive technology and tooltips', async () => {
    renderMembers();

    for (const label of [i18n.t('publicJoin.action'), i18n.t('members.csvImport.action'), i18n.t('members.invite')]) {
      expect(await screen.findByRole('button', { name: label })).toHaveAttribute('title', label);
    }
  });

  it('sends a manual invitation through configured email delivery and retains the fallback link', async () => {
    const user = userEvent.setup();
    apiMock.getInvitations.mockResolvedValue([{
      id: 'invitation-manual',
      email: 'manual@example.test',
      roles: ['MEMBER'],
      groupPermissions: [],
      categoryPermissions: [],
      roleAssignmentsVersion: 1,
      expiresAt: '2026-08-11T12:00:00Z',
      emailDeliveryStatus: 'SENT',
      emailSentAt: '2026-08-04T12:01:00Z',
    }]);
    renderMembers();

    await user.click(await screen.findByRole('button', { name: i18n.t('members.invite') }));
    await user.type(screen.getByLabelText(i18n.t('auth.email')), 'manual@example.test');
    await user.click(screen.getByRole('button', { name: i18n.t('members.createInvitation') }));

    await waitFor(() => expect(apiMock.createInvitation).toHaveBeenCalledWith('group-a', {
      email: 'manual@example.test', displayName: '', roleIds: ['role-member'], roles: ['MEMBER'], groupPermissions: [], categoryPermissions: [],
    }));
    expect(await screen.findByRole('heading', { name: i18n.t('members.invitationStatus.sentTitle') })).toBeVisible();
    expect(screen.getByText(i18n.t('members.invitationStatus.sentDescription', { email: 'manual@example.test' }))).toBeVisible();
    expect(screen.getByText(i18n.t('members.fallbackHint'))).toBeVisible();
    expect(screen.getByText('Der Link ist einmalig und bis 11.08.2026 gültig.')).toBeVisible();
    expect(screen.getByLabelText(i18n.t('members.invitationLink'))).toHaveValue('https://teamtaler.example/invite#token=manual-token');
  });

  it('assigns multiple reusable roles instead of direct invitation grants', async () => {
    const user = userEvent.setup();
    renderMembers();

    await user.click(await screen.findByRole('button', { name: i18n.t('members.invite') }));
    await user.type(screen.getByLabelText(i18n.t('auth.email')), 'rights@example.test');
    await user.type(screen.getByLabelText(i18n.t('auth.displayName')), 'Rights Member');
    await user.click(screen.getByRole('checkbox', { name: /Finanzverwaltung/i }));
    await user.click(screen.getByRole('button', { name: i18n.t('members.createInvitation') }));

    await waitFor(() => expect(apiMock.createInvitation).toHaveBeenCalledWith('group-a', {
      email: 'rights@example.test',
      displayName: 'Rights Member',
      roleIds: ['role-member', 'role-finance'],
      roles: ['MEMBER'],
      groupPermissions: [],
      categoryPermissions: [],
    }));
  });

  it('edits and resends an open invitation with a rotated fallback link', async () => {
    const user = userEvent.setup();
    renderMembers();

    await user.click(await screen.findByRole('button', { name: 'new@example.test' }));
    const nameInput = screen.getByLabelText(i18n.t('auth.displayName'));
    await user.clear(nameInput);
    await user.type(nameInput, 'Updated Member');
    const editDialog = screen.getByRole('dialog', { name: i18n.t('members.editInvitation') });
    await user.click(within(editDialog).getByRole('button', { name: i18n.t('common.save') }));
    await waitFor(() => expect(apiMock.updateInvitation).toHaveBeenCalledWith('group-a', 'invitation-new', {
      displayName: 'Updated Member', roleIds: ['role-member'], roleAssignmentsVersion: 3,
    }));

    await user.click(screen.getByRole('button', { name: i18n.t('members.resendFor', { email: 'new@example.test' }) }));
    const resendDialog = screen.getByRole('dialog', { name: i18n.t('members.resendTitle') });
    await user.click(within(resendDialog).getByRole('button', { name: i18n.t('members.resend') }));
    await waitFor(() => expect(apiMock.resendInvitationEmail).toHaveBeenCalledWith('group-a', 'invitation-new'));
    expect(within(resendDialog).getByText(i18n.t('members.oldLinksInvalid'))).toBeVisible();
    expect(within(resendDialog).getByLabelText(i18n.t('members.invitationLink'))).toHaveValue('https://teamtaler.example/invite#token=rotated');

    await user.click(within(resendDialog).getByRole('button', { name: i18n.t('common.done') }));
    await user.click(screen.getByRole('button', { name: i18n.t('members.deleteInvitationFor', { email: 'new@example.test' }) }));
    const deleteDialog = screen.getByRole('dialog', { name: i18n.t('members.deleteInvitationTitle') });
    expect(within(deleteDialog).getByText(i18n.t('members.deleteInvitationExplanation', { email: 'new@example.test' }))).toBeVisible();
    await user.click(within(deleteDialog).getByRole('button', { name: i18n.t('common.delete') }));
    await waitFor(() => expect(apiMock.revokeInvitation).toHaveBeenCalledWith('group-a', 'invitation-new'));
  });

  it('applies pending-invitation roles only after explicit confirmation', async () => {
    const user = userEvent.setup();
    renderMembers();

    await user.click(await screen.findByRole('button', { name: i18n.t('roleManagement.editRolesFor', { name: 'New Member' }) }));
    await user.click(screen.getByRole('checkbox', { name: /Finanzverwaltung/i }));
    expect(apiMock.updateInvitationRoles).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: i18n.t('roleManagement.applyAssignment') }));

    await waitFor(() => expect(apiMock.updateInvitationRoles).toHaveBeenCalledWith('group-a', 'invitation-new', ['role-member', 'role-finance'], 3));
  });

  it('applies member roles and uses one archive, reactivate, and delete lifecycle', async () => {
    const user = userEvent.setup();
    const former: Membership = { ...members[0], id: 'member-former', userId: 'user-former', email: 'former@example.test', displayName: 'Former Member', initials: 'FM', active: false, status: 'ARCHIVED', roles: ['MEMBER'], roleIds: [] };
    apiMock.getMembers.mockResolvedValue([...members, former]);
    renderMembers();

    await user.click(await screen.findByRole('button', { name: i18n.t('roleManagement.editRolesFor', { name: 'Admin' }) }));
    const roleDialog = screen.getByRole('dialog', { name: i18n.t('roleManagement.rolesFor', { name: 'Admin' }) });
    fireEvent.scroll(within(roleDialog).getByRole('group'));
    expect(roleDialog).toBeVisible();
    await user.click(screen.getByRole('checkbox', { name: /Finanzverwaltung/i }));
    expect(apiMock.updateMemberRoles).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: i18n.t('roleManagement.applyAssignment') }));
    await waitFor(() => expect(apiMock.updateMemberRoles).toHaveBeenCalledWith('group-a', 'member-admin', ['role-admin', 'role-member', 'role-finance'], 1));
    await user.click(screen.getByRole('button', { name: i18n.t('members.archiveFor', { name: 'Admin' }) }));
    const removeDialog = screen.getByRole('dialog', { name: i18n.t('members.archiveTitle') });
    await user.click(within(removeDialog).getByRole('button', { name: i18n.t('members.archive') }));
    await waitFor(() => expect(apiMock.archiveMember).toHaveBeenCalledWith('group-a', 'member-admin', true));

    await user.click(screen.getByRole('button', { name: i18n.t('members.reactivateFor', { name: former.displayName }) }));
    const reactivationDialog = screen.getByRole('dialog', { name: i18n.t('members.reactivateTitle') });
    expect(within(reactivationDialog).getByText(i18n.t('roleManagement.memberRoles'))).toBeVisible();
    expect(within(reactivationDialog).queryByText('roleManagement.memberRoles')).not.toBeInTheDocument();
    await user.click(within(reactivationDialog).getByRole('button', { name: i18n.t('members.reactivate') }));
    await waitFor(() => expect(apiMock.reactivateMember).toHaveBeenCalledWith('group-a', 'member-former', { displayName: undefined, roleIds: ['role-member'] }));

    await user.click(screen.getByRole('button', { name: i18n.t('members.permanentDeleteFor', { name: former.displayName }) }));
    const deleteDialog = screen.getByRole('dialog', { name: i18n.t('members.permanentDeleteTitle') });
    expect(within(deleteDialog).getByText(i18n.t('members.permanentDeleteExplanation', { name: 'Former Member' }))).toBeVisible();
    await user.click(within(deleteDialog).getByRole('button', { name: i18n.t('common.delete') }));
    await waitFor(() => expect(apiMock.permanentlyDeleteMember).toHaveBeenCalledWith('group-a', 'member-former'));
  });

  it('manages a credentialless guest without exposing login or role controls', async () => {
    const user = userEvent.setup();
    apiMock.getMembers.mockResolvedValue([...members, temporaryGuest]);
    renderMembers();

    expect(await screen.findByText(i18n.t('members.temporaryGuestBadge'))).toBeVisible();
    const guestRow = screen.getByRole('row', { name: new RegExp(temporaryGuest.displayName) });
    const guestCells = within(guestRow).getAllByRole('cell');
    expect(guestCells[1]).toBeEmptyDOMElement();
    expect(guestCells[2]).toBeEmptyDOMElement();
    expect(within(guestRow).getByText(i18n.t('members.claimGuest'), { exact: true })).toBeVisible();
    expect(screen.queryByRole('button', { name: i18n.t('roleManagement.editRolesFor', { name: temporaryGuest.displayName }) })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: i18n.t('members.renameGuestFor', { name: temporaryGuest.displayName }) }));
    const nameInput = screen.getByLabelText(i18n.t('auth.displayName'));
    await user.clear(nameInput);
    await user.type(nameInput, 'Renamed Guest');
    const renameDialog = screen.getByRole('dialog', { name: i18n.t('members.renameGuestTitle') });
    await user.click(within(renameDialog).getByRole('button', { name: i18n.t('common.save') }));
    await waitFor(() => expect(apiMock.renameMember).toHaveBeenCalledWith('group-a', temporaryGuest.id, 'Renamed Guest'));

    await user.click(screen.getByRole('button', { name: i18n.t('members.claimGuestFor', { name: temporaryGuest.displayName }) }));
    await user.type(screen.getByLabelText(i18n.t('auth.email')), 'guest@example.test');
    await user.click(screen.getByRole('button', { name: i18n.t('members.claimGuestCreate') }));
    await waitFor(() => expect(apiMock.createTemporaryGuestClaimInvitation).toHaveBeenCalledWith('group-a', temporaryGuest.id, 'guest@example.test', ['role-member']));
    expect(await screen.findByLabelText(i18n.t('members.invitationLink'))).toHaveValue('https://teamtaler.example/invite#token=claim-token');
    await user.click(screen.getByRole('button', { name: i18n.t('common.done') }));

    apiMock.getInvitations.mockClear();
    await user.click(screen.getByRole('button', { name: i18n.t('members.archiveFor', { name: temporaryGuest.displayName }) }));
    const archiveDialog = screen.getByRole('dialog', { name: i18n.t('members.archiveTitle') });
    await user.click(within(archiveDialog).getByRole('button', { name: i18n.t('members.archive') }));
    await waitFor(() => expect(apiMock.archiveMember).toHaveBeenCalledWith('group-a', temporaryGuest.id, false));
    await waitFor(() => expect(apiMock.getInvitations).toHaveBeenCalledWith('group-a'));
  });

  it('reactivates an archived guest without roles and keeps permanent deletion explicit', async () => {
    const user = userEvent.setup();
    const archivedGuest: Membership = { ...temporaryGuest, active: false, status: 'ARCHIVED' };
    apiMock.getMembers.mockResolvedValue([...members, archivedGuest]);
    renderMembers();

    await user.click(await screen.findByRole('button', { name: i18n.t('members.reactivateFor', { name: archivedGuest.displayName }) }));
    const reactivationDialog = screen.getByRole('dialog', { name: i18n.t('members.reactivateTitle') });
    const nameInput = within(reactivationDialog).getByLabelText(i18n.t('auth.displayName'));
    await user.clear(nameInput);
    await user.type(nameInput, 'Returning Guest');
    await user.click(within(reactivationDialog).getByRole('button', { name: i18n.t('members.reactivate') }));
    await waitFor(() => expect(apiMock.reactivateMember).toHaveBeenCalledWith('group-a', archivedGuest.id, { displayName: 'Returning Guest', roleIds: [] }));

    await user.click(screen.getByRole('button', { name: i18n.t('members.permanentDeleteFor', { name: archivedGuest.displayName }) }));
    const deleteDialog = screen.getByRole('dialog', { name: i18n.t('members.permanentDeleteTitle') });
    await user.click(within(deleteDialog).getByRole('button', { name: i18n.t('common.delete') }));
    await waitFor(() => expect(apiMock.permanentlyDeleteMember).toHaveBeenCalledWith('group-a', archivedGuest.id));
  });

  it('explains why a credentialless guest cannot be claimed before a default role is configured', async () => {
    apiMock.getMembers.mockResolvedValue([...members, temporaryGuest]);
    apiMock.getGroupSettings.mockResolvedValue({ notificationEmailsEnabled: false, notificationEmailDeliveryAvailable: true, defaultRoleId: null });
    renderMembers();

    const claimButton = await screen.findByRole('button', { name: i18n.t('members.claimGuestFor', { name: temporaryGuest.displayName }) });
    expect(claimButton).toBeDisabled();
    expect(claimButton).toHaveAttribute('title', i18n.t('members.claimUnavailableNoRole'));
    expect(screen.getByText(i18n.t('members.claimUnavailableNoRole'))).toBeVisible();
    expect(apiMock.createTemporaryGuestClaimInvitation).not.toHaveBeenCalled();
  });

  it('allows role managers to extend the preselected claim role', async () => {
    const user = userEvent.setup();
    apiMock.getMembers.mockResolvedValue([...members, temporaryGuest]);
    renderMembers();

    await user.click(await screen.findByRole('button', { name: i18n.t('members.claimGuestFor', { name: temporaryGuest.displayName }) }));
    await user.type(screen.getByLabelText(i18n.t('auth.email')), 'multi-role@example.test');
    await user.click(screen.getByRole('checkbox', { name: /Finanzverwaltung/i }));
    await user.click(screen.getByRole('button', { name: i18n.t('members.claimGuestCreate') }));

    await waitFor(() => expect(apiMock.createTemporaryGuestClaimInvitation).toHaveBeenCalledWith(
      'group-a',
      temporaryGuest.id,
      'multi-role@example.test',
      ['role-member', 'role-finance'],
    ));
  });

  it('assigns ordinary roles with member management alone', async () => {
    const user = userEvent.setup();
    const memberManagerSession: Session = {
      ...session,
      groups: [{
        ...session.groups[0],
        membership: {
          ...session.groups[0].membership!,
          effectiveGrants: [{ permission: 'MEMBER_MANAGEMENT', scope: { type: 'GROUP' } }],
        },
      }],
    };
    apiMock.getMembers.mockResolvedValue([...members, temporaryGuest]);
    renderMembers(memberManagerSession);

    await user.click(await screen.findByRole('button', { name: i18n.t('members.claimGuestFor', { name: temporaryGuest.displayName }) }));
    await user.click(screen.getByRole('checkbox', { name: /Finanzverwaltung/i }));
    await user.type(screen.getByLabelText(i18n.t('auth.email')), 'default-role@example.test');
    await user.click(screen.getByRole('button', { name: i18n.t('members.claimGuestCreate') }));

    await waitFor(() => expect(apiMock.createTemporaryGuestClaimInvitation).toHaveBeenCalledWith(
      'group-a',
      temporaryGuest.id,
      'default-role@example.test',
      ['role-member', 'role-finance'],
    ));
  });

  it('keeps claim-invitation roles locked while retaining resend and revoke actions', async () => {
    const claimInvitation: InvitationMetadata = {
      ...invitationMetadata[0],
      id: 'invitation-claim',
      email: 'guest@example.test',
      displayName: temporaryGuest.displayName,
      targetMembershipId: temporaryGuest.id,
    };
    apiMock.getInvitations.mockResolvedValue([claimInvitation]);
    renderMembers();

    expect(await screen.findByText(i18n.t('members.claimInvitationRoleLocked'))).toBeVisible();
    expect(screen.queryByRole('button', { name: i18n.t('members.editInvitationFor', { email: claimInvitation.email }) })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: i18n.t('roleManagement.editRolesFor', { name: temporaryGuest.displayName }) })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: i18n.t('members.resendFor', { email: claimInvitation.email }) })).toBeVisible();
    expect(screen.getByRole('button', { name: i18n.t('members.deleteInvitationFor', { email: claimInvitation.email }) })).toBeVisible();
  });

  it('allows a new claim after the previous claim invitation expired', async () => {
    const expiredClaim: InvitationMetadata = {
      ...invitationMetadata[0],
      id: 'invitation-expired-claim',
      email: 'expired-guest@example.test',
      displayName: temporaryGuest.displayName,
      expiresAt: '2020-01-01T00:00:00Z',
      targetMembershipId: temporaryGuest.id,
    };
    apiMock.getMembers.mockResolvedValue([...members, temporaryGuest]);
    apiMock.getInvitations.mockResolvedValue([expiredClaim]);
    renderMembers();

    expect(await screen.findByText(i18n.t('members.expired'))).toBeVisible();
    expect(screen.queryByText(i18n.t('members.claimPending'))).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: i18n.t('members.claimGuestFor', { name: temporaryGuest.displayName }) })).toBeEnabled();
  });

  it('explains link-only fallback when SMTP delivery is not configured', async () => {
    const user = userEvent.setup();
    apiMock.createInvitation.mockResolvedValue({
      id: 'invitation-link-only',
      email: 'link-only@example.test',
      roles: ['MEMBER'],
      groupPermissions: [],
      categoryPermissions: [],
      roleAssignmentsVersion: 1,
      expiresAt: '2026-08-11T12:00:00Z',
      acceptUrl: 'https://teamtaler.example/invite#token=link-only-token',
      emailDeliveryStatus: 'NOT_REQUESTED',
    });
    renderMembers();

    await user.click(await screen.findByRole('button', { name: i18n.t('members.invite') }));
    await user.type(screen.getByLabelText(i18n.t('auth.email')), 'link-only@example.test');
    await user.click(screen.getByRole('button', { name: i18n.t('members.createInvitation') }));

    expect(await screen.findByRole('heading', { name: i18n.t('members.invitationStatus.notRequestedTitle') })).toBeVisible();
    expect(screen.getByText(i18n.t('members.invitationStatus.notRequestedDescription', { email: 'link-only@example.test' }))).toBeVisible();
    expect(screen.queryByText(i18n.t('members.fallbackHint'))).not.toBeInTheDocument();
    expect(screen.getByLabelText(i18n.t('members.invitationLink'))).toHaveValue('https://teamtaler.example/invite#token=link-only-token');
    expect(apiMock.getInvitations).toHaveBeenCalledWith('group-a');
  });

  it('renews and redisplays a manual invitation link while SMTP remains unavailable', async () => {
    const user = userEvent.setup();
    const linkOnlyInvitation: InvitationMetadata = {
      ...invitationMetadata[0],
      email: 'link-only@example.test',
      emailDeliveryStatus: 'NOT_REQUESTED',
      emailSentAt: undefined,
    };
    apiMock.getGroupSettings.mockResolvedValue({ notificationEmailsEnabled: false, notificationEmailDeliveryAvailable: false, defaultRoleId: 'role-member' });
    apiMock.getInvitations.mockResolvedValue([linkOnlyInvitation]);
    apiMock.resendInvitationEmail.mockResolvedValue({
      invitationId: linkOnlyInvitation.id,
      emailDeliveryStatus: 'NOT_REQUESTED',
      expiresAt: '2026-08-13T12:00:00Z',
      acceptUrl: 'https://teamtaler.example/invite#token=renewed-manual',
    });
    renderMembers();

    await user.click(await screen.findByRole('button', { name: i18n.t('members.resendFor', { email: linkOnlyInvitation.email }) }));
    const dialog = screen.getByRole('dialog', { name: i18n.t('members.resendTitle') });
    expect(within(dialog).getByText(i18n.t('members.resendExplanationManual', { email: linkOnlyInvitation.email }))).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: i18n.t('members.resend') }));

    expect(await within(dialog).findByRole('heading', { name: i18n.t('members.invitationStatus.notRequestedTitle') })).toBeVisible();
    expect(within(dialog).getByLabelText(i18n.t('members.invitationLink'))).toHaveValue('https://teamtaler.example/invite#token=renewed-manual');
  });

  it('queues email and still displays the new link when SMTP was enabled after the original invitation', async () => {
    const user = userEvent.setup();
    const previouslyManualInvitation: InvitationMetadata = {
      ...invitationMetadata[0],
      email: 'later-smtp@example.test',
      emailDeliveryStatus: 'NOT_REQUESTED',
      emailSentAt: undefined,
    };
    apiMock.getGroupSettings.mockResolvedValue({ notificationEmailsEnabled: false, notificationEmailDeliveryAvailable: true, defaultRoleId: 'role-member' });
    apiMock.getInvitations.mockResolvedValue([previouslyManualInvitation]);
    apiMock.resendInvitationEmail.mockResolvedValue({
      invitationId: previouslyManualInvitation.id,
      emailDeliveryStatus: 'PENDING',
      expiresAt: '2026-08-13T12:00:00Z',
      acceptUrl: 'https://teamtaler.example/invite#token=renewed-and-queued',
    });
    renderMembers();

    await user.click(await screen.findByRole('button', { name: i18n.t('members.resendFor', { email: previouslyManualInvitation.email }) }));
    const dialog = screen.getByRole('dialog', { name: i18n.t('members.resendTitle') });
    expect(within(dialog).getByText(i18n.t('members.resendExplanationEmail', { email: previouslyManualInvitation.email }))).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: i18n.t('members.resend') }));

    expect(await within(dialog).findByRole('heading', { name: i18n.t('members.invitationStatus.pendingTitle') })).toBeVisible();
    expect(within(dialog).getByLabelText(i18n.t('members.invitationLink'))).toHaveValue('https://teamtaler.example/invite#token=renewed-and-queued');
  });

  it('offers the documented CSV schema and downloads a template', async () => {
    const user = userEvent.setup();
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderMembers();

    await user.click(await screen.findByRole('button', { name: i18n.t('members.csvImport.action') }));

    expect(screen.getByRole('dialog', { name: i18n.t('members.csvImport.title') })).toBeVisible();
    expect(screen.getByText(i18n.t('members.csvImport.membershipNotice'))).toBeVisible();
    expect(screen.getByText(i18n.t('members.csvImport.schema'))).toBeVisible();
    expect(screen.getByLabelText(i18n.t('members.csvImport.fileLabel'))).toHaveAttribute('accept', '.csv,text/csv');

    await user.click(screen.getByRole('button', { name: i18n.t('members.csvImport.downloadTemplate') }));

    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:member-import-template');
    expect(anchorClick).toHaveBeenCalledOnce();
  });

  it('imports a CSV and resolves pending email delivery through invitation polling', async () => {
    const user = userEvent.setup();
    const csv = new File(['email,display_name\nnew@example.test,New Member'], 'members.csv', { type: 'text/csv' });
    renderMembers();

    await user.click(await screen.findByRole('button', { name: i18n.t('members.csvImport.action') }));
    await user.upload(screen.getByLabelText(i18n.t('members.csvImport.fileLabel')), csv);
    expect(screen.getByText(i18n.t('members.csvImport.selectedFile', { name: csv.name }))).toBeVisible();
    expect(screen.getByRole('button', { name: i18n.t('members.csvImport.submit') })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: i18n.t('members.csvImport.submit') }));

    await waitFor(() => expect(apiMock.importInvitations).toHaveBeenCalledWith('group-a', csv));
    expect(await screen.findByText(i18n.t('members.csvImport.resultTitle'))).toBeVisible();
    await waitFor(() => expect(apiMock.getInvitations).toHaveBeenCalledWith('group-a'));

    const resultsTable = screen.getByRole('table', { name: i18n.t('members.csvImport.resultsTable') });
    const createdRow = within(resultsTable).getByRole('row', { name: /new@example\.test/i });
    expect(within(createdRow).getByText(i18n.t('members.csvImport.invitationStatus.created'))).toBeVisible();
    await waitFor(() => expect(within(createdRow).getByText(i18n.t('members.csvImport.deliveryStatus.sent'))).toBeVisible());
    expect(screen.getByText(i18n.t('members.csvImport.deliverySent', { count: 1 }))).toBeVisible();

    const invalidRow = within(resultsTable).getByRole('row', { name: /invalid-address/i });
    expect(within(invalidRow).getByText(i18n.t('members.csvImport.errors.invalidEmail'))).toBeVisible();
    const existingMemberRow = within(resultsTable).getByRole('row', { name: /admin@example\.test/i });
    expect(within(existingMemberRow).getByText(i18n.t('members.csvImport.invitationStatus.alreadyMember'))).toBeVisible();
    const existingInvitationRow = within(resultsTable).getByRole('row', { name: /invited@example\.test/i });
    expect(within(existingInvitationRow).getByText(i18n.t('members.csvImport.invitationStatus.alreadyInvited'))).toBeVisible();

    await user.click(screen.getByRole('button', { name: i18n.t('members.csvImport.importAnother') }));
    expect(screen.getByLabelText(i18n.t('members.csvImport.fileLabel'))).toBeVisible();
  });

  it('rejects an empty CSV before starting an import', async () => {
    const user = userEvent.setup();
    const emptyCsv = new File([], 'empty.csv', { type: 'text/csv' });
    renderMembers();

    await user.click(await screen.findByRole('button', { name: i18n.t('members.csvImport.action') }));
    await user.upload(screen.getByLabelText(i18n.t('members.csvImport.fileLabel')), emptyCsv);

    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('members.csvImport.emptyFile'));
    expect(screen.getByRole('button', { name: i18n.t('members.csvImport.submit') })).toBeDisabled();
    expect(apiMock.importInvitations).not.toHaveBeenCalled();
  });

  it('resends a failed invitation email with token rotation and resumes status polling', async () => {
    const user = userEvent.setup();
    const csv = new File(['email,display_name\nfailed@example.test,Failed Member'], 'members.csv', { type: 'text/csv' });
    const failedResult: InvitationImportResult = {
      summary: { totalRows: 1, created: 1, invalid: 0, skipped: 0 },
      rows: [{ row: 2, email: 'failed@example.test', displayName: 'Failed Member', invitationId: 'invitation-failed', invitationStatus: 'CREATED', emailDeliveryStatus: 'FAILED' }],
    };
    const failedMetadata: InvitationMetadata = {
      id: 'invitation-failed',
      email: 'failed@example.test',
      displayName: 'Failed Member',
      roles: ['MEMBER'],
      roleIds: ['role-member'],
      groupPermissions: [],
      categoryPermissions: [],
      roleAssignmentsVersion: 1,
      expiresAt: '2026-08-11T12:00:00Z',
      emailDeliveryStatus: 'FAILED',
    };
    const sentMetadata: InvitationMetadata = { ...failedMetadata, emailDeliveryStatus: 'SENT', emailSentAt: '2026-08-04T12:02:00Z' };
    apiMock.importInvitations.mockResolvedValue(failedResult);
    apiMock.getInvitations
      .mockResolvedValueOnce([failedMetadata])
      .mockResolvedValueOnce([failedMetadata])
      .mockResolvedValue([sentMetadata]);
    apiMock.resendInvitationEmail.mockResolvedValue({
      invitationId: 'invitation-failed',
      emailDeliveryStatus: 'PENDING',
      expiresAt: '2026-08-12T12:00:00Z',
      acceptUrl: 'https://teamtaler.example/invite#token=rotated-failed',
    });
    renderMembers();

    await user.click(await screen.findByRole('button', { name: i18n.t('members.csvImport.action') }));
    await user.upload(screen.getByLabelText(i18n.t('members.csvImport.fileLabel')), csv);
    await user.click(screen.getByRole('button', { name: i18n.t('members.csvImport.submit') }));

    const resultsTable = await screen.findByRole('table', { name: i18n.t('members.csvImport.resultsTable') });
    const row = within(resultsTable).getByRole('row', { name: /failed@example\.test/i });
    const retryLabel = i18n.t('members.csvImport.retryFor', { email: 'failed@example.test' });
    await user.click(within(row).getByRole('button', { name: retryLabel }));

    await waitFor(() => expect(apiMock.resendInvitationEmail).toHaveBeenCalledWith('group-a', 'invitation-failed'));
    await waitFor(() => expect(within(row).getByText(i18n.t('members.csvImport.deliveryStatus.sent'))).toBeVisible());
  });
});
