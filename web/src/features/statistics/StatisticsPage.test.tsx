import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Group, MemberStatistics, PermissionKey, Session } from '@/api/types';
import { ActiveGroupContext } from '@/app/active-group-context';
import { StatisticsPage } from './StatisticsPage';

const apiMock = vi.hoisted(() => ({ getMemberStatistics: vi.fn(), getFinanceStatistics: vi.fn() }));
vi.mock('@/api/client', () => ({ api: apiMock }));
vi.mock('./MemberStatisticsView', () => ({ MemberStatisticsView: ({ data }: { data: MemberStatistics }) => <output aria-label="Member projection">{data.memberSnapshot.regularMembers}</output> }));
vi.mock('./FinanceStatisticsView', () => ({ FinanceStatisticsView: () => <output aria-label="Finance projection">finance</output> }));

function group(id: string, permissions: readonly PermissionKey[]): Group {
  return {
    id, name: id, currency: 'EUR', defaultTheme: 'TEAMTALER', statisticsEnabled: true,
    membership: {
      id: `member-${id}`, roles: ['MEMBER'], groupPermissions: [], themeOverride: null,
      effectiveGrants: permissions.map((permission) => ({ permission, scope: { type: 'GROUP' } })),
    },
  };
}

function memberProjection(regularMembers: number): MemberStatistics {
  return {
    meta: {
      generatedAt: '2026-08-28T10:00:00Z', timezone: 'Europe/Berlin', preset: 'LAST_30_DAYS',
      fromInclusive: '2026-07-30T00:00:00Z', toExclusive: '2026-08-29T00:00:00Z', bucket: 'DAY',
      privacyThresholdApplied: false, currentPeriodAvailable: false,
    },
    memberSnapshot: { regularMembers, temporaryGuests: 0, asOf: '2026-08-28T10:00:00Z' },
    summary: { activeParticipants: 0, bookingCount: 0, validBookedUnits: 0, cancellationRate: null },
    activity: [], topCategories: { suppressed: false, items: [] }, topProducts: { suppressed: false, items: [] },
  };
}

function Harness({ activeGroup, client }: { activeGroup: Group; client: QueryClient }) {
  const session: Session = {
    user: { id: 'user-a', displayName: 'Alex', email: 'alex@example.test' }, groups: [activeGroup], activeGroupId: activeGroup.id,
    defaultGroupId: null, colorMode: 'SYSTEM', systemRoles: [],
  };
  return (
    <QueryClientProvider client={client}>
      <ActiveGroupContext.Provider value={{ session, activeGroup, activeGroupId: activeGroup.id, setActiveGroupId: vi.fn() }}>
        <StatisticsPage />
      </ActiveGroupContext.Provider>
    </QueryClientProvider>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe('StatisticsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/statistics?view=members');
  });
  afterEach(() => window.history.replaceState({}, '', '/'));

  it('loads only the active tab, normalizes the server default without a waterfall, and disables unavailable current period', async () => {
    const user = userEvent.setup();
    const activeGroup = group('group-a', ['VIEW_MEMBER_STATISTICS', 'VIEW_GROUP_STATISTICS']);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    apiMock.getMemberStatistics.mockResolvedValue(memberProjection(3));
    apiMock.getFinanceStatistics.mockResolvedValue({ ...memberProjection(0), currency: 'EUR' });
    render(<Harness activeGroup={activeGroup} client={client} />);

    expect(await screen.findByLabelText('Member projection')).toHaveTextContent('3');
    await waitFor(() => expect(apiMock.getMemberStatistics).toHaveBeenCalledTimes(1));
    expect(apiMock.getMemberStatistics).toHaveBeenCalledWith('group-a', {});
    expect(apiMock.getFinanceStatistics).not.toHaveBeenCalled();
    expect(screen.getByRole('option', { name: 'Aktueller Abrechnungszeitraum' })).toBeDisabled();
    expect(new URLSearchParams(window.location.search).get('range')).toBe('LAST_30_DAYS');

    const memberTab = screen.getByRole('tab', { name: 'Gruppenmitglieder' });
    await user.click(screen.getByRole('tab', { name: 'Finanzen' }));
    expect(await screen.findByLabelText('Finance projection')).toBeVisible();
    expect(apiMock.getFinanceStatistics).toHaveBeenCalledWith('group-a', {});

    await user.keyboard('{Home}');
    await waitFor(() => expect(memberTab).toHaveFocus());
  });

  it('never exposes the previous group projection as stale placeholder data', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const groupA = group('group-a', ['VIEW_MEMBER_STATISTICS']);
    const groupB = group('group-b', ['VIEW_MEMBER_STATISTICS']);
    const groupBProjection = deferred<MemberStatistics>();
    apiMock.getMemberStatistics.mockImplementation((groupId: string) => groupId === 'group-a' ? Promise.resolve(memberProjection(3)) : groupBProjection.promise);
    const rendered = render(<Harness activeGroup={groupA} client={client} />);
    expect(await screen.findByLabelText('Member projection')).toHaveTextContent('3');
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('range')).toBe('LAST_30_DAYS'));

    rendered.rerender(<Harness activeGroup={groupB} client={client} />);

    await waitFor(() => expect(screen.queryByLabelText('Member projection')).not.toBeInTheDocument());
    expect(apiMock.getMemberStatistics).toHaveBeenCalledWith('group-b', {});
    const projection = memberProjection(9);
    groupBProjection.resolve({
      ...projection,
      meta: { ...projection.meta, currentPeriodAvailable: true, preset: 'CURRENT_PERIOD' },
    });
    expect(await screen.findByLabelText('Member projection')).toHaveTextContent('9');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Zeitraum' })).toHaveValue('CURRENT_PERIOD'));
    expect(new URLSearchParams(window.location.search).get('range')).toBe('CURRENT_PERIOD');
  });
});
