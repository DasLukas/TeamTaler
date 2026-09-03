import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import type { Group, MemberStatistics, PermissionKey, Session, StatisticsDashboard } from '@/api/types';
import { ActiveGroupContext } from '@/app/active-group-context';
import { StatisticsPage } from './StatisticsPage';

const apiMock = vi.hoisted(() => ({ getStatistics: vi.fn() }));
vi.mock('@/api/client', () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    constructor(public readonly problem: { status: number }) {
      super('API error');
    }
  },
}));
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

function statisticsDashboard(regularMembers: number): StatisticsDashboard {
  const money = (minorUnits = '0') => ({ minorUnits, currency: 'EUR' });
  return {
    meta: {
      generatedAt: '2026-08-28T10:00:00Z', timezone: 'Europe/Berlin', preset: 'LAST_30_DAYS',
      fromInclusive: '2026-07-30T00:00:00Z', toExclusive: '2026-08-29T00:00:00Z', bucket: 'DAY',
      privacyThresholdApplied: false, currentPeriodAvailable: false,
    },
    members: {
      memberSnapshot: { regularMembers, temporaryGuests: 0, asOf: '2026-08-28T10:00:00Z' },
      summary: { activeParticipants: 0, bookingCount: 0, validBookedUnits: 0, cancellationRate: null },
      activity: [], topCategories: { suppressed: false, items: [] }, topProducts: { suppressed: false, items: [] },
    },
    finance: {
      currency: 'EUR',
      receivableSnapshot: { asOf: '2026-08-28T10:00:00Z', grossReceivable: money(), memberCredit: money(), netReceivable: money(), openAccountCount: 0, balancedAccountCount: 0, creditAccountCount: 0 },
      flows: { openingNetReceivable: money(), netBookingCharges: money(), netPayments: money(), netAdjustments: money(), closingNetReceivable: money() },
      series: [], categories: [], overdue: null,
    },
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

  it('loads one complete snapshot while presenting one statistics area at a time', async () => {
    const user = userEvent.setup();
    const activeGroup = group('group-a', ['VIEW_STATISTICS']);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    apiMock.getStatistics.mockResolvedValue(statisticsDashboard(3));
    render(<Harness activeGroup={activeGroup} client={client} />);

    expect(await screen.findByLabelText('Member projection')).toHaveTextContent('3');
    expect(screen.queryByLabelText('Finance projection')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Buchungen & Einkaufsübersicht' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Finanzen' })).not.toBeInTheDocument();
    const bookingsTab = screen.getByRole('tab', { name: 'Buchungen' });
    const financeTab = screen.getByRole('tab', { name: 'Finanzen' });
    expect(screen.getByRole('tablist', { name: 'Statistikbereich' })).toBeVisible();
    expect(bookingsTab).toHaveAttribute('aria-selected', 'true');
    expect(bookingsTab).toHaveAttribute('tabindex', '0');
    expect(financeTab).toHaveAttribute('aria-selected', 'false');
    expect(financeTab).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', bookingsTab.id);

    await user.click(financeTab);

    expect(screen.queryByLabelText('Member projection')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Finance projection')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Finanzen' })).toBeVisible();
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', financeTab.id);
    await waitFor(() => expect(apiMock.getStatistics).toHaveBeenCalledTimes(1));
    expect(apiMock.getStatistics).toHaveBeenCalledWith('group-a', {});
    expect(screen.queryByRole('button', { name: 'Aktualisieren' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Erstellt am/)).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Aktueller Abrechnungszeitraum' })).toBeDisabled();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('range')).toBe('LAST_30_DAYS'));
    expect(new URLSearchParams(window.location.search).has('view')).toBe(false);
  });

  it('supports automatic tab activation with roving keyboard focus', async () => {
    const user = userEvent.setup();
    const activeGroup = group('group-a', ['VIEW_STATISTICS']);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    apiMock.getStatistics.mockResolvedValue(statisticsDashboard(3));
    render(<Harness activeGroup={activeGroup} client={client} />);
    await screen.findByLabelText('Member projection');
    const bookingsTab = screen.getByRole('tab', { name: 'Buchungen' });
    const financeTab = screen.getByRole('tab', { name: 'Finanzen' });

    bookingsTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(financeTab).toHaveFocus();
    expect(financeTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Finance projection')).toBeVisible();

    await user.keyboard('{Home}');
    expect(bookingsTab).toHaveFocus();
    expect(screen.getByLabelText('Member projection')).toBeVisible();
    await user.keyboard('{ArrowLeft}');
    expect(financeTab).toHaveFocus();
    await user.keyboard('{End}');
    expect(financeTab).toHaveFocus();
    expect(apiMock.getStatistics).toHaveBeenCalledTimes(1);
  });

  it('automatically requests a new snapshot when the selected range changes', async () => {
    const user = userEvent.setup();
    const activeGroup = group('group-a', ['VIEW_STATISTICS']);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    apiMock.getStatistics.mockResolvedValue(statisticsDashboard(3));
    render(<Harness activeGroup={activeGroup} client={client} />);

    expect(await screen.findByLabelText('Member projection')).toHaveTextContent('3');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Zeitraum' })).toHaveValue('LAST_30_DAYS'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Zeitraum' }), 'LAST_90_DAYS');

    await waitFor(() => expect(apiMock.getStatistics).toHaveBeenCalledWith('group-a', { range: 'LAST_90_DAYS' }));
    expect(apiMock.getStatistics).toHaveBeenCalledTimes(2);
  });

  it('keeps the last complete snapshot visible when an automatic refetch fails', async () => {
    const user = userEvent.setup();
    const activeGroup = group('group-a', ['VIEW_STATISTICS']);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    apiMock.getStatistics.mockResolvedValueOnce(statisticsDashboard(3)).mockRejectedValueOnce(new Error('offline'));
    render(<Harness activeGroup={activeGroup} client={client} />);

    expect(await screen.findByLabelText('Member projection')).toHaveTextContent('3');
    await user.click(screen.getByRole('tab', { name: 'Finanzen' }));
    await act(async () => { await client.refetchQueries({ type: 'active' }); });

    expect(await screen.findByRole('alert')).toHaveTextContent('Die angezeigten Werte sind weiterhin verfügbar');
    expect(screen.queryByLabelText('Member projection')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Finance projection')).toBeVisible();
  });

  it.each([401, 403])('hides stale statistics when an automatic refetch invalidates access with %s', async (status) => {
    const activeGroup = group('group-a', ['VIEW_STATISTICS']);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    apiMock.getStatistics.mockResolvedValueOnce(statisticsDashboard(3)).mockRejectedValueOnce(new ApiError({ title: 'Access changed', status }));
    render(<Harness activeGroup={activeGroup} client={client} />);

    expect(await screen.findByLabelText('Member projection')).toHaveTextContent('3');
    await act(async () => { await client.refetchQueries({ type: 'active' }); });

    expect(await screen.findByText('Statistik nicht mehr verfügbar')).toBeVisible();
    expect(screen.queryByLabelText('Member projection')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Finance projection')).not.toBeInTheDocument();
    expect(screen.queryByText('Die angezeigten Werte sind weiterhin verfügbar')).not.toBeInTheDocument();
  });

  it('never exposes the previous group snapshot as placeholder data', async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const groupA = group('group-a', ['VIEW_STATISTICS']);
    const groupB = group('group-b', ['VIEW_STATISTICS']);
    const groupBProjection = deferred<StatisticsDashboard>();
    apiMock.getStatistics.mockImplementation((groupId: string) => groupId === 'group-a' ? Promise.resolve(statisticsDashboard(3)) : groupBProjection.promise);
    const rendered = render(<Harness activeGroup={groupA} client={client} />);
    expect(await screen.findByLabelText('Member projection')).toHaveTextContent('3');
    await user.click(screen.getByRole('tab', { name: 'Finanzen' }));
    expect(screen.getByLabelText('Finance projection')).toBeVisible();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('range')).toBe('LAST_30_DAYS'));

    rendered.rerender(<Harness activeGroup={groupB} client={client} />);

    await waitFor(() => expect(screen.queryByLabelText('Member projection')).not.toBeInTheDocument());
    expect(screen.queryByLabelText('Finance projection')).not.toBeInTheDocument();
    expect(apiMock.getStatistics).toHaveBeenCalledWith('group-b', {});
    const projection = statisticsDashboard(9);
    groupBProjection.resolve({
      ...projection,
      meta: { ...projection.meta, currentPeriodAvailable: true, preset: 'CURRENT_PERIOD' },
    });
    expect(await screen.findByLabelText('Member projection')).toHaveTextContent('9');
    expect(screen.getByRole('tab', { name: 'Buchungen' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByLabelText('Finance projection')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Zeitraum' })).toHaveValue('CURRENT_PERIOD'));
    expect(new URLSearchParams(window.location.search).get('range')).toBe('CURRENT_PERIOD');
  });
});
