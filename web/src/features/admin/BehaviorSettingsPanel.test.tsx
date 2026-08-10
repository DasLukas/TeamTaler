import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role, Session } from '@/api/types';
import { ActiveGroupContext } from '@/app/active-group-context';
import i18n from '@/i18n';
import { BehaviorSettingsPanel } from './BehaviorSettingsPanel';

const apiMock = vi.hoisted(() => ({
  getGroupSettings: vi.fn(),
  getRoles: vi.fn(),
  updateGroupSettings: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: apiMock }));

const session: Session = {
  user: { id: 'user-a', displayName: 'Admin', email: 'admin@example.test' },
  groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', membership: { id: 'member-a', roles: ['ADMIN', 'MEMBER'], groupPermissions: [] } }],
  activeGroupId: 'group-a',
};

function renderPanel(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ActiveGroupContext.Provider value={{ session, activeGroup: session.groups[0], activeGroupId: 'group-a', setActiveGroupId: vi.fn() }}>
        {children}
      </ActiveGroupContext.Provider>
    </QueryClientProvider>
  );
  render(<BehaviorSettingsPanel />, { wrapper });
  return queryClient;
}

describe('BehaviorSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getGroupSettings.mockResolvedValue({ notificationEmailsEnabled: false, notificationEmailDeliveryAvailable: true, defaultRoleId: 'role-member' });
    apiMock.getRoles.mockResolvedValue([{ id: 'role-member', name: 'Member', grants: [], version: 1, memberCount: 0, pendingInvitationCount: 0 }] satisfies Role[]);
  });

  it('removes the legacy booking-visibility switch from the new settings UI', async () => {
    renderPanel();
    expect(await screen.findByRole('switch', { name: i18n.t('behaviorSettings.notificationEmailToggle') })).toBeVisible();
    expect(screen.queryByRole('switch', { name: i18n.t('behaviorSettings.bookingVisibilityToggle') })).not.toBeInTheDocument();
  });

  it('renders notification delivery and the default role as separate settings regions', async () => {
    renderPanel();

    expect(await screen.findByRole('region', { name: i18n.t('behaviorSettings.notificationEmailTitle') })).toBeVisible();
    const defaultRoleRegion = screen.getByRole('region', { name: i18n.t('behaviorSettings.defaultRoleTitle') });
    expect(defaultRoleRegion).toBeVisible();
    expect(defaultRoleRegion.querySelector('span')).toBeNull();
  });

  it('saves notification email delivery only when SMTP is available', async () => {
    const user = userEvent.setup();
    apiMock.updateGroupSettings.mockResolvedValue({ notificationEmailsEnabled: true, notificationEmailDeliveryAvailable: true, defaultRoleId: 'role-member' });
    renderPanel();
    const toggle = await screen.findByRole('switch', { name: i18n.t('behaviorSettings.notificationEmailToggle') });

    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: i18n.t('behaviorSettings.save') }));

    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalledWith('group-a', { notificationEmailsEnabled: true }));
  });

  it('keeps notification email delivery visible but disabled without SMTP', async () => {
    apiMock.getGroupSettings.mockResolvedValue({ notificationEmailsEnabled: false, notificationEmailDeliveryAvailable: false, defaultRoleId: 'role-member' });
    renderPanel();

    expect(await screen.findByRole('switch', { name: i18n.t('behaviorSettings.notificationEmailToggle') })).toBeDisabled();
    expect(screen.getByText(i18n.t('behaviorSettings.notificationEmailUnavailable'))).toBeVisible();
  });

  it('shows a localized error when settings cannot be loaded', async () => {
    apiMock.getGroupSettings.mockRejectedValue(new Error('denied'));
    renderPanel();
    expect(await screen.findByText(i18n.t('behaviorSettings.loadError'))).toBeVisible();
  });

  it('persists a non-administrative default role', async () => {
    const user = userEvent.setup();
    apiMock.getRoles.mockResolvedValue([
      { id: 'role-member', name: 'Member', grants: [], version: 1, memberCount: 0, pendingInvitationCount: 0 },
      { id: 'role-finance', name: 'Finance', grants: [], version: 1, memberCount: 0, pendingInvitationCount: 0 },
      { id: 'role-admin', name: 'Admin', grants: [{ permission: 'GROUP_ADMINISTRATION', scope: { type: 'GROUP' } }], version: 1, memberCount: 1, pendingInvitationCount: 0 },
    ] satisfies Role[]);
    apiMock.updateGroupSettings.mockResolvedValue({ notificationEmailsEnabled: false, notificationEmailDeliveryAvailable: true, defaultRoleId: 'role-finance' });
    renderPanel();

    const select = await screen.findByLabelText(i18n.t('behaviorSettings.defaultRoleFieldLabel'));
    expect(screen.queryByRole('option', { name: 'Admin' })).not.toBeInTheDocument();
    await user.selectOptions(select, 'role-finance');
    await user.click(screen.getByRole('button', { name: i18n.t('behaviorSettings.save') }));

    await waitFor(() => expect(apiMock.updateGroupSettings).toHaveBeenCalledWith('group-a', { defaultRoleId: 'role-finance' }));
  });

  it('does not render a separate guest settings region', async () => {
    renderPanel();
    await screen.findByRole('region', { name: i18n.t('behaviorSettings.defaultRoleTitle') });
    expect(screen.queryByText('Guest role')).not.toBeInTheDocument();
  });
});
