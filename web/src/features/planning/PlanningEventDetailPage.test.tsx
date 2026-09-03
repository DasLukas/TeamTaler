import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanningEvent } from '@/api/types';
import { PlanningEventDetailPage } from './PlanningEventDetailPage';

const mocks = vi.hoisted(() => ({ getPlanningEvent: vi.fn(), getPlanningSettings: vi.fn() }));

vi.mock('@/api/client', () => ({ ApiError: class ApiError extends Error {}, api: { getPlanningEvent: mocks.getPlanningEvent, getPlanningSettings: mocks.getPlanningSettings } }));
vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => ({ activeGroupId: 'group-1', activeGroup: { membership: { effectiveGrants: [] } } }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => <a {...props}>{children}</a>,
  useParams: () => ({ eventId: 'all-day-event' }),
  useSearch: () => ({ view: 'month', date: '2026-09-05' }),
}));

describe('PlanningEventDetailPage all-day schedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPlanningSettings.mockResolvedValue({ enabled: true, version: 1, timeZone: 'Europe/Berlin' });
  });

  it('shows the inclusive date range and never renders derived midnight instants', async () => {
    const event: PlanningEvent = {
      id: 'all-day-event', version: 1, eventType: 'APPOINTMENT', status: 'PUBLISHED', title: 'Team weekend', description: '', location: '', allDay: true, startDate: '2026-09-05', endDateExclusive: '2026-09-08', timeZone: 'Europe/Berlin', startsAt: '2026-09-04T22:00:00Z', endsAt: '2026-09-07T22:00:00Z', waitlistEnabled: false, confirmationRevision: 1, audience: { type: 'ALL_ACTIVE_MEMBERS', roleIds: [], memberIds: [] }, participation: { invited: 0, attending: 0, maybe: 0, declined: 0, unanswered: 0, waitlisted: 0, reconfirmationRequired: 0 }, canEdit: false, canCancel: false, canRespond: false, canViewParticipants: false,
    };
    mocks.getPlanningEvent.mockResolvedValue(event);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={client}><PlanningEventDetailPage /></QueryClientProvider>);

    expect(await screen.findByText('05.09.2026–07.09.2026')).toBeVisible();
    expect(screen.getByText(/Ganztägig/)).toBeVisible();
    expect(screen.queryByText(/00:00/)).not.toBeInTheDocument();
  });
});
