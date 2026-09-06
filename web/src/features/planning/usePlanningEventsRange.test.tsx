import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api/client';
import type { PlanningEvent } from '@/api/types';
import { usePlanningEventsRange } from './usePlanningEventsRange';

const event: PlanningEvent = {
  id: 'first', version: 1, eventType: 'APPOINTMENT', status: 'PUBLISHED', title: 'First page', description: '', location: '', allDay: false, timeZone: 'Europe/Berlin', startsAt: '2026-09-01T10:00:00Z', endsAt: '2026-09-01T11:00:00Z', waitlistEnabled: false, confirmationRevision: 1, audience: { type: 'ALL_ACTIVE_MEMBERS', roleIds: [], memberIds: [] }, participation: { invited: 0, attending: 0, maybe: 0, declined: 0, unanswered: 0, waitlisted: 0, reconfirmationRequired: 0 }, canEdit: false, canCancel: false, canRespond: false, canViewParticipants: false,
};

describe('usePlanningEventsRange', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps accumulated results visible while loading the next cursor page', async () => {
    let resolveNext: ((value: { items: PlanningEvent[] }) => void) | undefined;
    vi.spyOn(api, 'getPlanningEvents')
      .mockResolvedValueOnce({ items: [event], nextCursor: 'next' })
      .mockReturnValueOnce(new Promise((resolve) => { resolveNext = resolve; }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const range = { dateKeys: ['2026-09-01'], from: '2026-08-31T22:00:00.000Z', fromDate: '2026-09-01', to: '2026-09-01T22:00:00.000Z', toDateExclusive: '2026-09-02' };

    const { result } = renderHook(() => usePlanningEventsRange('group-a', range, true), { wrapper });

    await waitFor(() => expect(result.current.events).toEqual([event]));
    expect(result.current.isLoadingMore).toBe(true);
    resolveNext?.({ items: [] });
    await waitFor(() => expect(result.current.isLoadingMore).toBe(false));
  });
});
