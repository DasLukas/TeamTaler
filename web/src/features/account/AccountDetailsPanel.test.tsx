import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Membership, Session } from '@/api/types';
import { ActiveGroupContext } from '@/app/active-group-context';
import i18n from '@/i18n';
import { AccountDetailsPanel } from './AccountDetailsPanel';

const apiMock = vi.hoisted(() => ({
  getAuthenticationCapabilities: vi.fn(),
  updateProfile: vi.fn(),
  updateDefaultGroup: vi.fn(),
  changePassword: vi.fn(),
  requestEmailChange: vi.fn(),
}));
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({ api: apiMock, ApiError: class ApiError extends Error {}, clearAuthenticatedClientState: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigateMock }));

const session: Session = {
  user: { id: 'user-a', displayName: 'Alex Member', email: 'alex@example.test' },
  groups: [
    { id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: 'member-a', roles: ['MEMBER'], groupPermissions: [] } },
    { id: 'group-b', name: 'Group B', currency: 'EUR', membership: { id: 'member-b', roles: ['MEMBER'], groupPermissions: [] } },
  ],
  activeGroupId: 'group-a',
  defaultGroupId: null,
};

function renderPanel(sessionValue: Session = session): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const member: Membership = { id: 'member-a', userId: 'user-a', displayName: 'Alex Member', email: 'alex@example.test', initials: 'AM', isTemporaryGuest: false, roles: ['MEMBER'], groupPermissions: [], categoryPermissions: [], status: 'ACTIVE', active: true };
  queryClient.setQueryData(['session'], sessionValue);
  queryClient.setQueryData(['members', 'group-a'], [member]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ActiveGroupContext.Provider value={{ session: sessionValue, activeGroup: sessionValue.groups[0], activeGroupId: 'group-a', setActiveGroupId: vi.fn() }}>{children}</ActiveGroupContext.Provider>
    </QueryClientProvider>
  );
  render(<AccountDetailsPanel />, { wrapper });
  return queryClient;
}

function rowFor(value: string): HTMLElement {
  const row = screen.getByText(value).closest('div');
  if (!row) throw new Error(`Missing account row for ${value}`);
  return row;
}

describe('AccountDetailsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getAuthenticationCapabilities.mockResolvedValue({ passwordResetAvailable: true, emailChangeAvailable: true });
    apiMock.updateProfile.mockResolvedValue({ ...session.user, displayName: 'Alex Changed' });
    apiMock.updateDefaultGroup.mockImplementation(async (defaultGroupId: string | null) => ({ defaultGroupId }));
    apiMock.changePassword.mockResolvedValue(undefined);
    apiMock.requestEmailChange.mockResolvedValue({ verificationRequired: true });
    navigateMock.mockResolvedValue(undefined);
  });

  it('fails closed for email changes while keeping name and password actions', async () => {
    apiMock.getAuthenticationCapabilities.mockRejectedValue(new Error('offline'));
    renderPanel();

    expect(within(rowFor('Alex Member')).getByRole('button', { name: i18n.t('common.edit') })).toBeVisible();
    expect(within(rowFor('••••••••••••')).getByRole('button', { name: i18n.t('common.edit') })).toBeVisible();
    expect(within(rowFor('alex@example.test')).queryByRole('button', { name: i18n.t('common.edit') })).not.toBeInTheDocument();
  });

  it('updates the global name and cached membership projection', async () => {
    const user = userEvent.setup();
    const queryClient = renderPanel();
    await user.click(within(rowFor('Alex Member')).getByRole('button', { name: i18n.t('common.edit') }));
    const input = screen.getByLabelText(i18n.t('account.details.name'));
    await user.clear(input);
    await user.type(input, 'Alex Changed');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: i18n.t('common.save') }));

    await waitFor(() => expect(apiMock.updateProfile).toHaveBeenCalledWith('Alex Changed'));
    expect(queryClient.getQueryData<Session>(['session'])?.user.displayName).toBe('Alex Changed');
    expect(queryClient.getQueryData<Membership[]>(['members', 'group-a'])?.[0].displayName).toBe('Alex Changed');
    expect(await screen.findByText(i18n.t('account.details.nameSaved'))).toHaveAttribute('role', 'status');
  });

  it('offers every available group plus last-used behavior and persists a fixed default', async () => {
    const user = userEvent.setup();
    const queryClient = renderPanel();

    const selection = screen.getByLabelText(i18n.t('account.details.defaultGroup'));
    expect(selection).toHaveValue('__LAST_USED_GROUP__');
    expect(within(selection).getByRole('option', { name: i18n.t('account.details.lastUsedGroup') })).toBeVisible();
    expect(within(selection).getByRole('option', { name: 'Group A' })).toBeVisible();
    expect(within(selection).getByRole('option', { name: 'Group B' })).toBeVisible();

    await user.selectOptions(selection, 'group-b');
    await user.click(within(rowFor(i18n.t('account.details.defaultGroup'))).getByRole('button', { name: i18n.t('common.save') }));

    await waitFor(() => expect(apiMock.updateDefaultGroup).toHaveBeenCalledWith('group-b'));
    expect(queryClient.getQueryData<Session>(['session'])?.defaultGroupId).toBe('group-b');
    expect(await screen.findByText(i18n.t('account.details.defaultGroupSaved'))).toHaveAttribute('role', 'status');
  });

  it('hides the default-group setting for accounts with only one group', () => {
    renderPanel({ ...session, groups: session.groups.slice(0, 1) });

    expect(screen.queryByLabelText(i18n.t('account.details.defaultGroup'))).not.toBeInTheDocument();
  });

  it('restores last-used behavior from a fixed default group', async () => {
    const user = userEvent.setup();
    const queryClient = renderPanel({ ...session, defaultGroupId: 'group-a' });

    const selection = screen.getByLabelText(i18n.t('account.details.defaultGroup'));
    expect(selection).toHaveValue('group-a');
    await user.selectOptions(selection, '__LAST_USED_GROUP__');
    await user.click(within(rowFor(i18n.t('account.details.defaultGroup'))).getByRole('button', { name: i18n.t('common.save') }));

    await waitFor(() => expect(apiMock.updateDefaultGroup).toHaveBeenCalledWith(null));
    expect(queryClient.getQueryData<Session>(['session'])?.defaultGroupId).toBeNull();
  });

  it('rejects blank and control-character names before the request', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(within(rowFor('Alex Member')).getByRole('button', { name: i18n.t('common.edit') }));
    const input = screen.getByLabelText(i18n.t('account.details.name'));
    await user.clear(input);
    await user.type(input, '   ');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: i18n.t('common.save') }));
    expect(await screen.findByText(i18n.t('auth.displayNameRequired'))).toBeVisible();
    expect(apiMock.updateProfile).not.toHaveBeenCalled();
  });

  it('changes the password and returns to login after clearing authenticated queries', async () => {
    const user = userEvent.setup();
    const queryClient = renderPanel();
    await user.click(within(rowFor('••••••••••••')).getByRole('button', { name: i18n.t('common.edit') }));
    await user.type(screen.getByLabelText(i18n.t('account.details.currentPassword')), 'current-passphrase');
    await user.type(screen.getByLabelText(i18n.t('auth.newPassword')), 'changed-passphrase');
    await user.type(screen.getByLabelText(i18n.t('auth.passwordConfirmation')), 'changed-passphrase');
    await user.click(screen.getByRole('button', { name: i18n.t('auth.savePassword') }));

    await waitFor(() => expect(apiMock.changePassword).toHaveBeenCalledWith('current-passphrase', 'changed-passphrase'));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/login', replace: true }));
    expect(queryClient.getQueryData(['session'])).toBeUndefined();
  });

  it('requests email verification without changing the current session email', async () => {
    const user = userEvent.setup();
    const queryClient = renderPanel();
    const emailRow = rowFor('alex@example.test');
    const editEmail = await waitFor(() => within(emailRow).getByRole('button', { name: i18n.t('common.edit') }));
    await user.click(editEmail);
    await user.type(screen.getByLabelText(i18n.t('account.details.newEmail')), 'new@example.test');
    await user.type(screen.getByLabelText(i18n.t('account.details.currentPassword')), 'current-passphrase');
    await user.click(screen.getByRole('button', { name: i18n.t('account.details.emailRequest') }));

    await waitFor(() => expect(apiMock.requestEmailChange).toHaveBeenCalledWith('new@example.test', 'current-passphrase'));
    expect(queryClient.getQueryData<Session>(['session'])?.user.email).toBe('alex@example.test');
    expect(await screen.findByText(i18n.t('account.details.emailRequestedMessage'))).toBeVisible();
  });
});
