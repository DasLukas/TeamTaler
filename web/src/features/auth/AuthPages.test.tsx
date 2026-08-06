import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { InvitationPage } from './InvitationPage';
import { LoginPage } from './LoginPage';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  previewInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  api: { login: mocks.login, previewInvitation: mocks.previewInvitation, acceptInvitation: mocks.acceptInvitation },
  isDevelopmentDemoEnabled: false,
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => mocks.navigate,
}));

const session = {
  user: { id: 'user-a', displayName: 'Alex', email: 'alex@example.test' },
  groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: 'member-a', roles: ['MEMBER'] as const, groupPermissions: [] } }],
  activeGroupId: 'group-a',
};

function renderPage(page: ReactNode): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={queryClient}>{page}</QueryClientProvider>);
}

describe('authentication form policies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.login.mockResolvedValue(session);
  mocks.previewInvitation.mockResolvedValue({ displayName: '', existingAccount: false });
    mocks.acceptInvitation.mockResolvedValue(session);
    mocks.navigate.mockResolvedValue(undefined);
  });

  it('does not enforce a local minimum length during login', async () => {
    const user = userEvent.setup();
    renderPage(<LoginPage />);
    await user.type(screen.getByLabelText(i18n.t('auth.email')), 'alex@example.test');
    await user.type(screen.getByLabelText(i18n.t('auth.password')), 'short');
    await user.click(screen.getByRole('button', { name: i18n.t('auth.loginAction') }));
    await waitFor(() => expect(mocks.login).toHaveBeenCalled());
    expect(mocks.login.mock.calls[0]?.[0]).toEqual({ email: 'alex@example.test', password: 'short' });
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: '/book' }));
  });

  it('requires 12 characters for a new account and uses a neutral acceptance action', async () => {
    window.history.replaceState(null, '', '/invite#token=invite-token');
    const user = userEvent.setup();
    renderPage(<InvitationPage />);
    await user.type(await screen.findByLabelText(i18n.t('auth.displayName')), 'Alex');
    await user.type(screen.getByLabelText(i18n.t('auth.password')), 'short');
    await user.type(screen.getByLabelText(i18n.t('auth.passwordConfirmation')), 'short');
    await user.click(screen.getByRole('button', { name: i18n.t('auth.acceptInvitation') }));

    expect(await screen.findByText(i18n.t('auth.passwordMinTwelve'))).toBeVisible();
    expect(mocks.acceptInvitation).not.toHaveBeenCalled();
  });

  it('rejects an existing account password below the invitation contract minimum', async () => {
  mocks.previewInvitation.mockResolvedValue({ displayName: 'Alex', existingAccount: true });
    window.history.replaceState(null, '', '/invite#token=invite-token');
    const user = userEvent.setup();
    renderPage(<InvitationPage />);
  await screen.findByRole('checkbox', { name: i18n.t('auth.existingAccountDetected') });
    expect(screen.getByText(i18n.t('auth.existingPasswordHint'))).toBeVisible();
  expect(screen.getByLabelText(i18n.t('auth.displayName'))).toHaveValue('Alex');
  expect(screen.getByLabelText(i18n.t('auth.displayName'))).toHaveAttribute('readonly');
    await user.type(screen.getByLabelText(i18n.t('auth.existingPasswordLabel')), 'short');
    await user.click(screen.getByRole('button', { name: i18n.t('auth.acceptInvitation') }));

    expect(await screen.findByText(i18n.t('auth.passwordMinTwelve'))).toBeVisible();
    expect(mocks.acceptInvitation).not.toHaveBeenCalled();
  });

  it('accepts a contract-valid current password for an existing account', async () => {
  mocks.previewInvitation.mockResolvedValue({ displayName: 'Alex', existingAccount: true });
    window.history.replaceState(null, '', '/invite#token=invite-token');
    const user = userEvent.setup();
    renderPage(<InvitationPage />);
  await screen.findByRole('checkbox', { name: i18n.t('auth.existingAccountDetected') });
    await user.type(screen.getByLabelText(i18n.t('auth.existingPasswordLabel')), 'existing-pass');
    await user.click(screen.getByRole('button', { name: i18n.t('auth.acceptInvitation') }));

    await waitFor(() => expect(mocks.acceptInvitation).toHaveBeenCalledWith({ token: 'invite-token', displayName: 'Alex', password: 'existing-pass' }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: '/book' }));
  });

  it('pre-fills an invited display name and lets a new account change it', async () => {
    mocks.previewInvitation.mockResolvedValue({ displayName: 'Suggested Name', existingAccount: false });
    window.history.replaceState(null, '', '/invite#token=invite-token');
    const user = userEvent.setup();
    renderPage(<InvitationPage />);
    const displayName = await screen.findByLabelText(i18n.t('auth.displayName'));
    await waitFor(() => expect(displayName).toHaveValue('Suggested Name'));
    await user.clear(displayName);
    await user.type(displayName, 'Chosen Name');
    await user.type(screen.getByLabelText(i18n.t('auth.password')), 'new-passphrase');
    await user.type(screen.getByLabelText(i18n.t('auth.passwordConfirmation')), 'new-passphrase');
    await user.click(screen.getByRole('button', { name: i18n.t('auth.acceptInvitation') }));
    await waitFor(() => expect(mocks.acceptInvitation).toHaveBeenCalledWith({ token: 'invite-token', displayName: 'Chosen Name', password: 'new-passphrase' }));
  });
});
