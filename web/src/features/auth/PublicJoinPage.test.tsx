import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { PublicJoinPage } from './PublicJoinPage';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  previewPublicJoinLink: vi.fn(),
  login: vi.fn(),
  acceptPublicJoinLink: vi.fn(),
  startPublicJoinRegistration: vi.fn(),
  resendPublicJoinVerification: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: mocks }));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><PublicJoinPage /></QueryClientProvider>);
}

const joinedSession = {
  user: { id: 'user-a', displayName: 'Alex', email: 'alex@example.test' },
  groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: 'member-a', roleIds: ['role-member'], effectiveGrants: [{ permission: 'CREATE_OWN_BOOKING', scope: { type: 'GROUP' } }] } }],
  activeGroupId: 'group-a',
};

describe('PublicJoinPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/join#token=public-token');
    mocks.getSession.mockRejectedValue(new Error('Unauthenticated'));
    mocks.previewPublicJoinLink.mockResolvedValue({ groupName: 'Group A', expiresAt: null });
    mocks.startPublicJoinRegistration.mockResolvedValue({ verificationRequired: true });
    mocks.resendPublicJoinVerification.mockResolvedValue({ verificationRequired: true });
    mocks.acceptPublicJoinLink.mockResolvedValue(joinedSession);
    mocks.navigate.mockResolvedValue(undefined);
  });

  it('starts a neutral email-verification flow for a new account', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('tab', { name: i18n.t('publicJoin.newAccount') }));
    await user.type(screen.getByLabelText(i18n.t('auth.email')), 'new@example.test');
    await user.type(screen.getByLabelText(i18n.t('auth.displayName')), 'New Member');
    await user.type(screen.getByLabelText(i18n.t('auth.password')), 'new-password-long');
    await user.type(screen.getByLabelText(i18n.t('auth.passwordConfirmation')), 'new-password-long');
    await user.click(screen.getByRole('button', { name: i18n.t('publicJoin.register') }));

    await waitFor(() => expect(mocks.startPublicJoinRegistration).toHaveBeenCalledWith({
      joinToken: 'public-token',
      email: 'new@example.test',
      displayName: 'New Member',
      password: 'new-password-long',
    }));
    expect(await screen.findByRole('heading', { name: i18n.t('publicJoin.checkEmailTitle') })).toBeVisible();
    await user.click(screen.getByRole('button', { name: i18n.t('publicJoin.resend') }));
    await waitFor(() => expect(mocks.resendPublicJoinVerification).toHaveBeenCalledWith('public-token', 'new@example.test'));
  });

  it('joins directly for the current authenticated account', async () => {
    const currentSession = { ...joinedSession, activeGroupId: undefined };
    mocks.getSession.mockResolvedValue(currentSession);
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: i18n.t('publicJoin.joinCurrentAccount') }));

    await waitFor(() => expect(mocks.acceptPublicJoinLink).toHaveBeenCalledWith('public-token'));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: '/book' }));
    expect(window.location.hash).toBe('');
  });

  it('never sends an invalid fragment token to a public endpoint', async () => {
    window.history.replaceState(null, '', '/join');
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('publicJoin.invalidTitle'));
    expect(mocks.previewPublicJoinLink).not.toHaveBeenCalled();
  });
});
