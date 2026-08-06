import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationPage } from '@/api/types';
import { notificationSummaryKey } from './notification-summary';
import { NotificationsPage } from './NotificationsPage';

const apiMock = vi.hoisted(() => ({ getNotificationsPage: vi.fn(), markNotificationsRead: vi.fn() }));
vi.mock('@/api/client', () => ({ api: apiMock }));
vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => ({ activeGroupId: 'group-a' }) }));

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

function renderPage(queryClient: QueryClient) {
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  render(<NotificationsPage />, { wrapper });
}

describe('NotificationsPage visibility acknowledgement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
