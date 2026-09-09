import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanningEvent, PlanningEventBase, PlanningTimedEventTiming } from '@/api/types';
import i18n from '@/i18n';
import { PlanningEventDetailPage } from './PlanningEventDetailPage';
import styles from './Planning.module.css';

const mocks = vi.hoisted(() => ({ getPlanningEvent: vi.fn(), getPlanningSettings: vi.fn() }));

/**
 * Creates a complete planning-event projection for detail-page tests.
 *
 * @param overrides - Event properties that differ from the default appointment.
 * @returns A planning event suitable for rendering the detail page.
 */
function planningEvent(overrides: Partial<PlanningEventBase & PlanningTimedEventTiming> = {}): PlanningEvent {
  return {
    id: 'all-day-event',
    version: 1,
    eventType: 'APPOINTMENT',
    status: 'PUBLISHED',
    title: 'Team evening',
    description: 'Weekly planning',
    location: 'Clubhouse',
    allDay: false,
    timeZone: 'Europe/Berlin',
    startsAt: '2026-09-09T09:00:00+02:00',
    endsAt: '2026-09-09T10:00:00+02:00',
    waitlistEnabled: false,
    confirmationRevision: 1,
    audience: { type: 'ALL_ACTIVE_MEMBERS', roleIds: [], memberIds: [] },
    participation: { invited: 0, attending: 0, maybe: 0, declined: 0, unanswered: 0, waitlisted: 0, reconfirmationRequired: 0 },
    canEdit: true,
    canCancel: true,
    canRespond: false,
    canViewParticipants: false,
    ...overrides,
  };
}

vi.mock('@/api/client', () => ({ ApiError: class ApiError extends Error {}, api: { getPlanningEvent: mocks.getPlanningEvent, getPlanningSettings: mocks.getPlanningSettings } }));
vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => ({ activeGroupId: 'group-1', activeGroup: { membership: { effectiveGrants: [] } } }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, params, search, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode; params?: unknown; search?: unknown; to: string }) => {
    void params;
    void search;
    return <a href={to} {...props}>{children}</a>;
  },
  useParams: () => ({ eventId: 'all-day-event' }),
  useSearch: () => ({ view: 'month', date: '2026-09-05' }),
}));

describe('PlanningEventDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPlanningSettings.mockResolvedValue({ enabled: true, version: 1, timeZone: 'Europe/Berlin' });
  });

  it('shows the inclusive date range and never renders derived midnight instants', async () => {
    const event: PlanningEvent = {
      id: 'all-day-event',
      version: 1,
      eventType: 'APPOINTMENT',
      status: 'PUBLISHED',
      title: 'Team weekend',
      description: '',
      location: '',
      allDay: true,
      startDate: '2026-09-05',
      endDateExclusive: '2026-09-08',
      timeZone: 'Europe/Berlin',
      startsAt: '2026-09-04T22:00:00Z',
      endsAt: '2026-09-07T22:00:00Z',
      waitlistEnabled: false,
      confirmationRevision: 1,
      audience: { type: 'ALL_ACTIVE_MEMBERS', roleIds: [], memberIds: [] },
      participation: { invited: 0, attending: 0, maybe: 0, declined: 0, unanswered: 0, waitlisted: 0, reconfirmationRequired: 0 },
      canEdit: false,
      canCancel: false,
      canRespond: false,
      canViewParticipants: false,
    };
    mocks.getPlanningEvent.mockResolvedValue(event);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><PlanningEventDetailPage /></QueryClientProvider>);

    expect(await screen.findByText('05.09.2026–07.09.2026')).toBeVisible();
    expect(screen.getByText(/Ganztägig/)).toBeVisible();
    expect(screen.queryByText(/00:00/)).not.toBeInTheDocument();
  });

  it('hides closing for appointments while keeping editing and cancellation', async () => {
    const event = planningEvent();
    mocks.getPlanningEvent.mockResolvedValue(event);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><PlanningEventDetailPage /></QueryClientProvider>);

    const backLink = await screen.findByRole('link', { name: i18n.t('planning.backToCalendar') });
    const editLink = screen.getByRole('link', { name: i18n.t('common.edit') });
    expect(backLink.parentElement).toBe(editLink.parentElement);
    expect(backLink.parentElement).toHaveClass(styles.detailNavigation);
    expect(editLink).toHaveClass(styles.detailEditLink);
    expect(editLink).toHaveAttribute('title', i18n.t('common.edit'));

    expect(screen.queryByRole('button', { name: i18n.t('planning.actions.close') })).not.toBeInTheDocument();
    const cancelButton = screen.getByRole('button', { name: i18n.t('planning.actions.cancel') });
    const lifecycleActions = cancelButton.parentElement;
    const eventCard = screen.getByText('Clubhouse').closest('section');
    expect(lifecycleActions).toContainElement(cancelButton);
    expect(lifecycleActions).toHaveClass(styles.detailManagementActions);
    expect(eventCard?.nextElementSibling).toBe(lifecycleActions);
  });

  it.each(['APPOINTMENT_POLL', 'APPOINTMENT_REGISTRATION'] as const)('keeps closing available for %s events', async (eventType) => {
    mocks.getPlanningEvent.mockResolvedValue(planningEvent({ eventType }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><PlanningEventDetailPage /></QueryClientProvider>);

    expect(await screen.findByRole('button', { name: i18n.t('planning.actions.close') })).toBeVisible();
    expect(screen.getByRole('button', { name: i18n.t('planning.actions.cancel') })).toBeVisible();
  });
});
