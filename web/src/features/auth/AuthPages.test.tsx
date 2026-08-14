import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { InvitationPage } from './InvitationPage';
import { LoginPage } from './LoginPage';
import { ForgotPasswordPage } from './ForgotPasswordPage';
import { ResetPasswordPage } from './ResetPasswordPage';
import { EmailChangeConfirmationPage } from './EmailChangeConfirmationPage';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  previewInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
  getAuthenticationCapabilities: vi.fn(),
  requestPasswordReset: vi.fn(),
  confirmPasswordReset: vi.fn(),
  confirmEmailChange: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  api: { login: mocks.login, previewInvitation: mocks.previewInvitation, acceptInvitation: mocks.acceptInvitation, getAuthenticationCapabilities: mocks.getAuthenticationCapabilities, requestPasswordReset: mocks.requestPasswordReset, confirmPasswordReset: mocks.confirmPasswordReset, confirmEmailChange: mocks.confirmEmailChange },
  clearAuthenticatedClientState: vi.fn(),
  isDevelopmentDemoEnabled: false,
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => mocks.navigate,
}));

const session = {
  user: { id: 'user-a', displayName: 'Alex', email: 'alex@example.test' },
  groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: 'member-a', roles: ['MEMBER'] as const, groupPermissions: [], effectiveGrants: [{ permission: 'CREATE_OWN_BOOKING' as const, scope: { type: 'GROUP' as const } }] } }],
  activeGroupId: 'group-a',
};

function renderPage(page: ReactNode): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={queryClient}>{page}</QueryClientProvider>);
  return queryClient;
}

describe('authentication form policies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.login.mockResolvedValue(session);
    mocks.previewInvitation.mockResolvedValue({ displayName: '', existingAccount: false });
    mocks.acceptInvitation.mockResolvedValue(session);
    mocks.getAuthenticationCapabilities.mockResolvedValue({ passwordResetAvailable: true, emailChangeAvailable: true });
    mocks.requestPasswordReset.mockResolvedValue(undefined);
    mocks.confirmPasswordReset.mockResolvedValue(undefined);
    mocks.confirmEmailChange.mockResolvedValue(undefined);
    mocks.navigate.mockResolvedValue(undefined);
  });

  it('presents the product with a concise benefit-led slogan', () => {
    renderPage(<LoginPage />);

    expect(screen.getByRole('heading', { name: /Mehr Miteinander.*Weniger Rechnerei/ })).toBeVisible();
    expect(screen.getByText('TeamTaler macht gemeinsame Ausgaben fair, klar und entspannt.')).toBeVisible();
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

  it('shows a safe localized message for invalid credentials', async () => {
    const user = userEvent.setup();
    mocks.login.mockRejectedValue({ problem: { status: 401, detail: 'authentication required' } });
    renderPage(<LoginPage />);

    await user.type(screen.getByLabelText(i18n.t('auth.email')), 'alex@example.test');
    await user.type(screen.getByLabelText(i18n.t('auth.password')), 'incorrect-password');
    await user.click(screen.getByRole('button', { name: i18n.t('auth.loginAction') }));

    expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('auth.invalidCredentials'));
    expect(screen.queryByText('authentication required')).not.toBeInTheDocument();
  });

  it('explains rate limiting without exposing a technical API message', async () => {
    const user = userEvent.setup();
    mocks.login.mockRejectedValue({ problem: { status: 429, detail: 'rate limited' } });
    renderPage(<LoginPage />);

    await user.type(screen.getByLabelText(i18n.t('auth.email')), 'alex@example.test');
    await user.type(screen.getByLabelText(i18n.t('auth.password')), 'incorrect-password');
    await user.click(screen.getByRole('button', { name: i18n.t('auth.loginAction') }));

    expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('auth.tooManyLoginAttempts'));
    expect(screen.queryByText('rate limited')).not.toBeInTheDocument();
  });

  it('hides password recovery when the deployment capability is unavailable', async () => {
    mocks.getAuthenticationCapabilities.mockResolvedValue({ passwordResetAvailable: false, emailChangeAvailable: false });
    renderPage(<LoginPage />);

    await waitFor(() => expect(mocks.getAuthenticationCapabilities).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: i18n.t('auth.forgotPassword') })).not.toBeInTheDocument();
  });

  it('requests a reset without exposing account existence', async () => {
    const user = userEvent.setup();
    renderPage(<ForgotPasswordPage />);
    await user.type(await screen.findByLabelText(i18n.t('auth.email')), 'alex@example.test');
    await user.click(screen.getByRole('button', { name: i18n.t('auth.sendResetLink') }));

    await waitFor(() => expect(mocks.requestPasswordReset).toHaveBeenCalledWith('alex@example.test'));
    expect(await screen.findByText(i18n.t('auth.resetRequestedMessage'))).toBeVisible();
  });

  it('captures and removes the reset fragment before submitting a new password', async () => {
    window.history.replaceState(null, '', '/reset-password#token=reset-secret');
    const user = userEvent.setup();
    renderPage(<ResetPasswordPage />);

    expect(window.location.hash).toBe('');
    await user.type(screen.getByLabelText(i18n.t('auth.newPassword')), 'new-passphrase');
    await user.type(screen.getByLabelText(i18n.t('auth.passwordConfirmation')), 'new-passphrase');
    await user.click(screen.getByRole('button', { name: i18n.t('auth.savePassword') }));

    await waitFor(() => expect(mocks.confirmPasswordReset).toHaveBeenCalledWith('reset-secret', 'new-passphrase'));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: '/login', replace: true }));
  });

  it('confirms an email change once and removes its fragment immediately', async () => {
    window.history.replaceState(null, '', '/email-change/confirm#token=email-secret');
    renderPage(<EmailChangeConfirmationPage />);

    expect(window.location.hash).toBe('');
    await waitFor(() => expect(mocks.confirmEmailChange).toHaveBeenCalledTimes(1));
    expect(mocks.confirmEmailChange).toHaveBeenCalledWith('email-secret');
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: '/login', replace: true }));
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
