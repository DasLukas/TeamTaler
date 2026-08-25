import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationPage, Session } from '@/api/types';
import { ActiveGroupContext, type ActiveGroupSelectionOptions } from '@/app/active-group-context';
import { notificationSummaryKey } from './notification-summary';
import { NotificationsPage } from './NotificationsPage';

const apiMock = vi.hoisted(() => ({ getNotificationDestination: vi.fn(), getNotificationsPage: vi.fn(), markNotificationsRead: vi.fn() }));
vi.mock('@/api/client', () => ({ api: apiMock }));

const session: Session = {
  user: { id: 'user-a', displayName: 'Alex', email: 'alex@example.test' },
  groups: [
    { id: 'group-a', name: 'Group A', currency: 'EUR', defaultTheme: 'TEAMTALER', membership: { id: 'member-a', roles: ['MEMBER'], groupPermissions: [], themeOverride: null } },
    { id: 'group-b', name: 'Group B', currency: 'EUR', defaultTheme: 'TEAMTALER', membership: { id: 'member-b', roles: ['MEMBER'], groupPermissions: [], themeOverride: null } },
  ],
  activeGroupId: 'group-a',
  defaultGroupId: null,
  colorMode: 'SYSTEM',
  systemRoles: [],
};

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = [];
  private readonly elements = new Set<Element>();

  constructor(private readonly callback: IntersectionObserverCallback) {
    TestIntersectionObserver.instances.push(this);
  }

  observe(element: Element) { this.elements.add(element); }
  disconnect() { this.elements.clear(); }
  unobserve(element: Element) { this.elements.delete(element); }
  takeRecords(): IntersectionObserverEntry[] { return []; }
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0];

  trigger(element: Element) {
    if (!this.elements.has(element)) return;
    this.callback([{ isIntersecting: true, target: element } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

function renderPage(queryClient: QueryClient, onSelect = vi.fn()) {
  const GroupHarness = ({ children }: { children: ReactNode }) => {
    const [activeGroupId, setActiveGroupId] = useState('group-a');
    const select = (groupId: string, options?: ActiveGroupSelectionOptions) => {
      onSelect(groupId, options);
      setActiveGroupId(groupId);
    };
    const activeGroup = session.groups.find((group) => group.id === activeGroupId) ?? session.groups[0]!;
    return <ActiveGroupContext.Provider value={{ session, activeGroup, activeGroupId, setActiveGroupId: select }}>{children}</ActiveGroupContext.Provider>;
  };
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}><GroupHarness>{children}</GroupHarness></QueryClientProvider>;
  render(<NotificationsPage />, { wrapper });
}

describe('NotificationsPage visibility acknowledgement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/notifications');
    TestIntersectionObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
  });

  it('marks an unread card on first viewport contact and reconciles the shared count', async () => {
    const page: NotificationPage = { items: [{
      id: 'notification-a', title: 'Neue Buchung', message: 'Sam hat dir Wasser zugewiesen.',
      createdAt: '2026-08-04T12:00:00Z', kind: 'BOOKING', eventType: 'BOOKING_ASSIGNED', context: {},
    }] };
    apiMock.getNotificationsPage.mockResolvedValue(page);
    apiMock.markNotificationsRead.mockResolvedValue({ unreadCount: 0, readAt: '2026-08-04T12:01:00Z' });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    queryClient.setQueryData(notificationSummaryKey('group-a'), { unreadCount: 1 });
    renderPage(queryClient);

    const article = await screen.findByRole('article');
    expect(screen.queryByRole('button', { name: 'Gelesen' })).not.toBeInTheDocument();
    const observer = TestIntersectionObserver.instances[0];
    await act(async () => observer?.trigger(article));

    await waitFor(() => expect(apiMock.markNotificationsRead).toHaveBeenCalledWith('group-a', ['notification-a']));
    await waitFor(() => expect(queryClient.getQueryData(notificationSummaryKey('group-a'))).toEqual({ unreadCount: 0 }));
    expect(await screen.findByText('Gelesen')).toBeVisible();
  });

  it('resolves a push notification to another owned group before showing its inbox', async () => {
    const selected = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    window.history.replaceState({}, '', '/notifications?notification=notification-b');
    apiMock.getNotificationDestination.mockResolvedValue({ groupId: 'group-b' });
    apiMock.getNotificationsPage.mockImplementation(async (groupId: string): Promise<NotificationPage> => ({ items: [{
      id: `notification-${groupId}`, title: groupId, message: `Inbox ${groupId}`,
      createdAt: '2026-08-20T12:00:00Z', readAt: '2026-08-20T12:01:00Z', kind: 'SYSTEM', eventType: 'SYSTEM', context: {},
    }] }));

    renderPage(queryClient, selected);

    await waitFor(() => expect(selected).toHaveBeenCalledWith('group-b', { preserveRoute: true }));
    expect(await screen.findByText('Inbox group-b')).toBeVisible();
    expect(apiMock.getNotificationDestination).toHaveBeenCalledWith('notification-b');
    expect(apiMock.getNotificationsPage).toHaveBeenCalledWith('group-b', undefined);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['notifications', 'group-b'], exact: true });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['notification-summary', 'group-b'], exact: true });
  });

  it('keeps the current inbox when an opaque destination is inaccessible', async () => {
    const selected = vi.fn();
    const page: NotificationPage = { items: [{
      id: 'notification-a', title: 'Current group', message: 'Still visible',
      createdAt: '2026-08-20T12:00:00Z', readAt: '2026-08-20T12:01:00Z', kind: 'SYSTEM', eventType: 'SYSTEM', context: {},
    }] };
    window.history.replaceState({}, '', '/notifications?notification=unknown-notification');
    apiMock.getNotificationDestination.mockRejectedValue(new Error('not found'));
    apiMock.getNotificationsPage.mockResolvedValue(page);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    renderPage(queryClient, selected);

    expect(await screen.findByText('Still visible')).toBeVisible();
    expect(apiMock.getNotificationDestination).toHaveBeenCalledTimes(1);
    expect(selected).not.toHaveBeenCalled();
  });
});
