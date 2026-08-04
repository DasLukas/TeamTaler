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
  acceptInvitation: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  api: { login: mocks.login, acceptInvitation: mocks.acceptInvitation },
  isDevelopmentDemoEnabled: false,
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => mocks.navigate,
}));

const session = {
  user: { id: 'user-a', displayName: 'Alex', email: 'alex@example.test' },
  groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: 'member-a', roles: ['MEMBER'] as const } }],
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
  });

  it('requires 12 characters for a new account and uses a neutral acceptance action', async () => {
    window.history.replaceState(null, '', '/invite#token=invite-token');
    const user = userEvent.setup();
    renderPage(<InvitationPage />);
    await user.type(screen.getByLabelText(i18n.t('auth.displayName')), 'Alex');
    await user.type(screen.getByLabelText(i18n.t('auth.password')), 'short');
    await user.type(screen.getByLabelText(i18n.t('auth.passwordConfirmation')), 'short');
    await user.click(screen.getByRole('button', { name: i18n.t('auth.acceptInvitation') }));

    expect(await screen.findByText(i18n.t('auth.passwordMinTwelve'))).toBeVisible();
    expect(mocks.acceptInvitation).not.toHaveBeenCalled();
  });

  it('rejects an existing account password below the invitation contract minimum', async () => {
    window.history.replaceState(null, '', '/invite#token=invite-token');
    const user = userEvent.setup();
    renderPage(<InvitationPage />);
    await user.click(screen.getByRole('checkbox', { name: i18n.t('auth.existingAccount') }));
    expect(screen.getByText(i18n.t('auth.existingPasswordHint'))).toBeVisible();
    await user.type(screen.getByLabelText(i18n.t('auth.displayName')), 'Alex');
    await user.type(screen.getByLabelText(i18n.t('auth.existingPasswordLabel')), 'short');
    await user.click(screen.getByRole('button', { name: i18n.t('auth.acceptInvitation') }));

    expect(await screen.findByText(i18n.t('auth.passwordMinTwelve'))).toBeVisible();
    expect(mocks.acceptInvitation).not.toHaveBeenCalled();
  });

  it('accepts a contract-valid current password for an existing account', async () => {
    window.history.replaceState(null, '', '/invite#token=invite-token');
    const user = userEvent.setup();
    renderPage(<InvitationPage />);
    await user.click(screen.getByRole('checkbox', { name: i18n.t('auth.existingAccount') }));
    await user.type(screen.getByLabelText(i18n.t('auth.displayName')), 'Alex');
    await user.type(screen.getByLabelText(i18n.t('auth.existingPasswordLabel')), 'existing-pass');
    await user.click(screen.getByRole('button', { name: i18n.t('auth.acceptInvitation') }));

    await waitFor(() => expect(mocks.acceptInvitation).toHaveBeenCalledWith({ token: 'invite-token', displayName: 'Alex', password: 'existing-pass' }));
  });
});
