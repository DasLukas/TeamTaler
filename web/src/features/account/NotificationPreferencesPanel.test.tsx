import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationPreferences, Session } from '@/api/types';
import { ActiveGroupContext } from '@/app/active-group-context';
import { SessionContext } from '@/app/session-context';
import { DEFAULT_INSTANCE_CAPABILITIES } from '@/app/useSession';
import { notificationKeys } from '@/features/notifications/notificationQueryKeys';
import i18n from '@/i18n';
import { NotificationPreferencesPanel } from './NotificationPreferencesPanel';

const apiMock = vi.hoisted(() => ({
  deletePushSubscription: vi.fn(),
  getNotificationPreferences: vi.fn(),
  getPushSubscriptions: vi.fn(),
  renamePushSubscription: vi.fn(),
  updateNotificationPreferences: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: apiMock }));
vi.mock('@/features/push/webPush', () => ({
  currentWebPushDeviceId: () => null,
  disableWebPushForCurrentBrowser: vi.fn(),
  enableWebPush: vi.fn(),
  isIOSBrowser: () => false,
  isStandaloneWebApp: () => false,
  supportsWebPush: () => false,
}));

const session: Session = {
  user: { id: 'user-a', displayName: 'Alex', email: 'alex@example.test' },
  groups: [{ id: 'group-a', name: 'Group A', currency: 'EUR', defaultTheme: 'TEAMTALER', statisticsEnabled: false, membership: { id: 'member-a', roles: ['MEMBER'], groupPermissions: [], themeOverride: null } }],
  activeGroupId: 'group-a',
  defaultGroupId: null,
  colorMode: 'SYSTEM',
  systemRoles: [],
};

const preferences: NotificationPreferences = {
  version: 2,
  channels: { email: true, push: false },
  events: [
    {
      eventType: 'BOOKING_ASSIGNED', category: 'BOOKINGS', name: 'Booking assigned', description: '', supportedChannels: ['EMAIL', 'PUSH'],
      enabled: true, email: true, push: false, emailAvailable: true, pushAvailable: false,
    },
    {
      eventType: 'SETTLEMENT_DUE_SOON', category: 'SETTLEMENTS', name: 'Settlement due soon', description: '', supportedChannels: ['EMAIL', 'PUSH'],
      enabled: false, email: false, push: false, emailAvailable: false, pushAvailable: false,
    },
  ],
};

function renderPanel(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>
    <SessionContext.Provider value={{ session, instanceCapabilities: DEFAULT_INSTANCE_CAPABILITIES }}>
      <ActiveGroupContext.Provider value={{ session, activeGroup: session.groups[0], activeGroupId: 'group-a', setActiveGroupId: vi.fn() }}>{children}</ActiveGroupContext.Provider>
    </SessionContext.Provider>
  </QueryClientProvider>;
  render(<NotificationPreferencesPanel />, { wrapper });
  return queryClient;
}

describe('NotificationPreferencesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getNotificationPreferences.mockResolvedValue(preferences);
    apiMock.getPushSubscriptions.mockResolvedValue([]);
    apiMock.updateNotificationPreferences.mockResolvedValue({ ...preferences, version: 3, events: [{ ...preferences.events[0], email: false }, preferences.events[1]] });
  });

  it('persists only an editable changed channel and keeps group-disabled rows immutable', async () => {
    const user = userEvent.setup();
    renderPanel();

    const emailToggle = await screen.findByRole('switch', { name: i18n.t('notifications.preferences.emailFor', { event: i18n.t('notifications.preferences.events.bookingAssigned.label') }) });
    const pushToggle = screen.getByRole('switch', { name: i18n.t('notifications.preferences.pushFor', { event: i18n.t('notifications.preferences.events.bookingAssigned.label') }) });
    const disabledEmailToggle = screen.getByRole('switch', { name: i18n.t('notifications.preferences.emailFor', { event: i18n.t('notifications.preferences.events.settlementDueSoon.label') }) });
    expect(pushToggle).toBeDisabled();
    expect(disabledEmailToggle).toBeDisabled();
    expect(screen.queryByText('Auf dem Sperrbildschirm erscheinen nur Gruppenname und Ereignisart.')).not.toBeInTheDocument();

    await user.click(emailToggle);
    await user.click(screen.getByRole('button', { name: i18n.t('common.save') }));

    await waitFor(() => expect(apiMock.updateNotificationPreferences).toHaveBeenCalledWith('group-a', {
      version: 2,
      events: [{ eventType: 'BOOKING_ASSIGNED', email: false }],
    }));
  });

  it('shows the concise notice when email delivery is unavailable', async () => {
    apiMock.getNotificationPreferences.mockResolvedValue({ ...preferences, channels: { ...preferences.channels, email: false } });
    renderPanel();

    expect(await screen.findByText('E-Mail-Benachrichtigungen sind derzeit nicht verfügbar.')).toBeVisible();
  });

  it('renders only module events exposed by the server projection', async () => {
    apiMock.getNotificationPreferences.mockResolvedValue({ ...preferences, events: [preferences.events[0]] });
    renderPanel();

    expect(await screen.findByText(i18n.t('notifications.preferences.events.bookingAssigned.label'))).toBeVisible();
    expect(screen.queryByText(i18n.t('notifications.preferences.events.settlementDueSoon.label'))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t('notifications.preferences.events.planningPublished.label'))).not.toBeInTheDocument();
  });

  it('rebuilds editable rows when the server projection changes without a version increment', async () => {
    const queryClient = renderPanel();
    expect(await screen.findByText(i18n.t('notifications.preferences.events.settlementDueSoon.label'))).toBeVisible();
    apiMock.getNotificationPreferences.mockResolvedValue({ ...preferences, events: [preferences.events[0]] });

    await queryClient.invalidateQueries({ queryKey: notificationKeys.preferences('group-a') });

    await waitFor(() => expect(screen.queryByText(i18n.t('notifications.preferences.events.settlementDueSoon.label'))).not.toBeInTheDocument());
    expect(screen.getByText(i18n.t('notifications.preferences.events.bookingAssigned.label'))).toBeVisible();
  });
});
