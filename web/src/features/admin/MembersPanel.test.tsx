import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvitationImportResult, InvitationMetadata, Membership, Session } from '@/api/types';
import { ActiveGroupContext } from '@/app/active-group-context';
import i18n from '@/i18n';
import { MembersPanel } from './MembersPanel';

const apiMock = vi.hoisted(() => ({
  getMembers: vi.fn(),
  getCategories: vi.fn(),
  createInvitation: vi.fn(),
  updateInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
  resendInvitationEmail: vi.fn(),
  archiveMember: vi.fn(),
  importInvitations: vi.fn(),
  getInvitations: vi.fn(),
  retryInvitationEmail: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: apiMock }));

const session: Session = {
  user: { id: 'user-admin', displayName: 'Admin', email: 'admin@example.test' },
  groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: 'member-admin', roles: ['ADMIN', 'MEMBER'], groupPermissions: [] } }],
  activeGroupId: 'group-a',
};

const members: Membership[] = [{
  id: 'member-admin',
  userId: 'user-admin',
  displayName: 'Admin',
  email: 'admin@example.test',
  initials: 'A',
  roles: ['ADMIN', 'MEMBER'],
  groupPermissions: [],
  categoryPermissions: [],
  active: true,
}];

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
function renderMembers(onOpenRights?: (membershipId: string) => void): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ActiveGroupContext.Provider value={{ session, activeGroup: session.groups[0], activeGroupId: 'group-a', setActiveGroupId: vi.fn() }}>
        {children}
      </ActiveGroupContext.Provider>
    </QueryClientProvider>
  );
  render(<MembersPanel onOpenRights={onOpenRights} />, { wrapper });
  return queryClient;
}

describe('MembersPanel invitations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getMembers.mockResolvedValue(members);
  apiMock.getCategories.mockResolvedValue([]);
    apiMock.createInvitation.mockResolvedValue({
      id: 'invitation-manual',
      email: 'manual@example.test',
      roles: ['MEMBER'],
      groupPermissions: [],
      categoryPermissions: [],
      expiresAt: '2026-08-11T12:00:00Z',
      acceptUrl: 'https://teamtaler.example/invite#token=manual-token',
      emailDeliveryStatus: 'PENDING',
    });
    apiMock.importInvitations.mockResolvedValue(importResult);
    apiMock.getInvitations.mockResolvedValue(invitationMetadata);
    apiMock.retryInvitationEmail.mockResolvedValue({ invitationId: 'invitation-new', emailDeliveryStatus: 'PENDING' });
  apiMock.updateInvitation.mockImplementation((_groupId: string, _invitationId: string, input: { displayName: string; roles: Membership['roles']; groupPermissions: Membership['groupPermissions']; categoryPermissions: Membership['categoryPermissions'] }) => Promise.resolve({ ...invitationMetadata[0], ...input }));
  apiMock.revokeInvitation.mockResolvedValue(undefined);
  apiMock.resendInvitationEmail.mockResolvedValue({ invitationId: 'invitation-new', emailDeliveryStatus: 'PENDING', expiresAt: '2026-08-12T12:00:00Z', acceptUrl: 'https://teamtaler.example/invite#token=rotated' });
  apiMock.archiveMember.mockResolvedValue(undefined);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:member-import-template') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  });

  it('sends a manual invitation through configured email delivery and retains the fallback link', async () => {
    const user = userEvent.setup();
    apiMock.getInvitations.mockResolvedValue([{
      id: 'invitation-manual',
      email: 'manual@example.test',
      roles: ['MEMBER'],
      groupPermissions: [],
      categoryPermissions: [],
      expiresAt: '2026-08-11T12:00:00Z',
      emailDeliveryStatus: 'SENT',
      emailSentAt: '2026-08-04T12:01:00Z',
    }]);
    renderMembers();

    await user.click(await screen.findByRole('button', { name: i18n.t('members.invite') }));
    await user.type(screen.getByLabelText(i18n.t('auth.email')), 'manual@example.test');
    await user.click(screen.getByRole('button', { name: i18n.t('members.createInvitation') }));

    await waitFor(() => expect(apiMock.createInvitation).toHaveBeenCalledWith('group-a', { email: 'manual@example.test', displayName: '', roles: ['MEMBER'], groupPermissions: [], categoryPermissions: [] }));
    expect(await screen.findByRole('heading', { name: i18n.t('members.invitationStatus.sentTitle') })).toBeVisible();
    expect(screen.getByText(i18n.t('members.invitationStatus.sentDescription', { email: 'manual@example.test' }))).toBeVisible();
    expect(screen.getByText(i18n.t('members.fallbackHint'))).toBeVisible();
    expect(screen.getByLabelText(i18n.t('members.invitationLink'))).toHaveValue('https://teamtaler.example/invite#token=manual-token');
  });

  it('assigns an optional display name, group role, and category grant to a manual invitation', async () => {
    const user = userEvent.setup();
    apiMock.getCategories.mockResolvedValue([{ id: 'category-a', name: 'Drinks', icon: 'drink', active: true, products: [] }]);
    renderMembers();

    await user.click(await screen.findByRole('button', { name: i18n.t('members.invite') }));
    await user.type(screen.getByLabelText(i18n.t('auth.email')), 'rights@example.test');
    await user.type(screen.getByLabelText(i18n.t('auth.displayName')), 'Rights Member');
    await user.click(screen.getByRole('switch', { name: i18n.t('rights.toggleRole', { role: i18n.t('roles.finance.label'), name: 'Rights Member' }) }));
    await user.click(screen.getByRole('switch', { name: i18n.t('rights.selfPayment.toggle', { name: 'Rights Member' }) }));
    await user.click(screen.getByRole('switch', { name: i18n.t('rights.categoryAssign', { category: 'Drinks' }) }));
    await user.click(screen.getByRole('button', { name: i18n.t('members.createInvitation') }));

    await waitFor(() => expect(apiMock.createInvitation).toHaveBeenCalledWith('group-a', {
      email: 'rights@example.test',
      displayName: 'Rights Member',
      roles: ['MEMBER', 'FINANCE_MANAGER'],
      groupPermissions: ['SELF_RECORD_PAYMENT'],
      categoryPermissions: [{ categoryId: 'category-a', assignToOthers: true, voidBookings: false }],
    }));
  });

  it('edits and resends an open invitation with a rotated fallback link', async () => {
    const user = userEvent.setup();
    renderMembers();

    await user.click(await screen.findByRole('button', { name: 'new@example.test' }));
    const nameInput = screen.getByLabelText(i18n.t('auth.displayName'));
    await user.clear(nameInput);
    await user.type(nameInput, 'Updated Member');
    await user.click(screen.getByRole('button', { name: i18n.t('common.save') }));
    await waitFor(() => expect(apiMock.updateInvitation).toHaveBeenCalledWith('group-a', 'invitation-new', {
      displayName: 'Updated Member', roles: ['MEMBER'], groupPermissions: [], categoryPermissions: [],
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

  it('opens active-member rights and archives or re-invites memberships from separate sections', async () => {
    const user = userEvent.setup();
    const onOpenRights = vi.fn();
    const former: Membership = { ...members[0], id: 'member-former', userId: 'user-former', email: 'former@example.test', displayName: 'Former Member', initials: 'FM', active: false, roles: ['MEMBER'] };
    apiMock.getMembers.mockResolvedValue([...members, former]);
    renderMembers(onOpenRights);

    await user.click(await screen.findByRole('button', { name: 'Admin' }));
    expect(onOpenRights).toHaveBeenCalledWith('member-admin');
    await user.click(screen.getByRole('button', { name: i18n.t('members.inviteAgain') }));
    expect(screen.getByLabelText(i18n.t('auth.email'))).toHaveValue('former@example.test');
    await user.click(screen.getByRole('button', { name: i18n.t('common.cancel') }));

    await user.click(screen.getByRole('button', { name: i18n.t('members.removeFor', { name: 'Admin' }) }));
    const removeDialog = screen.getByRole('dialog', { name: i18n.t('members.removeSelfTitle') });
    await user.click(within(removeDialog).getByRole('button', { name: i18n.t('members.confirmSelfRemoval') }));
    await waitFor(() => expect(apiMock.archiveMember).toHaveBeenCalledWith('group-a', 'member-admin', true));
  });

  it('explains link-only fallback when SMTP delivery is not configured', async () => {
    const user = userEvent.setup();
    apiMock.createInvitation.mockResolvedValue({
      id: 'invitation-link-only',
      email: 'link-only@example.test',
      roles: ['MEMBER'],
      groupPermissions: [],
      categoryPermissions: [],
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
    expect(screen.getByLabelText(i18n.t('members.invitationLink'))).toHaveValue('https://teamtaler.example/invite#token=link-only-token');
    expect(apiMock.getInvitations).toHaveBeenCalledWith('group-a');
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
      groupPermissions: [],
      categoryPermissions: [],
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
