import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupRole } from '@/api/types';
import { demoDashboard, demoMembers, demoSession } from '@/demo/data';
import i18n from '@/i18n';
import { DashboardPage } from './DashboardPage';

const mocks = vi.hoisted(() => ({
  getDashboard: vi.fn(),
  getMembers: vi.fn(),
  getCategories: vi.fn(),
  useActiveGroup: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  api: {
    getDashboard: mocks.getDashboard,
    getMembers: mocks.getMembers,
    getCategories: mocks.getCategories,
    createOwnPayment: vi.fn(),
  },
}));

vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => mocks.useActiveGroup() }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

describe('DashboardPage information-only overview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDashboard.mockResolvedValue(demoDashboard);
    mocks.getMembers.mockResolvedValue(demoMembers);
    mocks.useActiveGroup.mockReturnValue({ activeGroupId: demoSession.activeGroupId, activeGroup: demoSession.groups[0], session: demoSession });
  });

  it('keeps all information blocks without loading or rendering booking controls', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><DashboardPage /></QueryClientProvider>);

    expect(await screen.findByText(i18n.t('dashboard.recentActivities'))).toBeVisible();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Lukas');
    expect(screen.getAllByText(/23,40/).length).toBeGreaterThan(0);
    expect(screen.getByText(i18n.t('dashboard.settlement', { label: 'August' }))).toBeVisible();
    expect(screen.getByText(demoDashboard.currentPeriod.label)).toBeVisible();
    expect(screen.getByText(i18n.t('dashboard.paymentNoteSelf'))).toBeVisible();
    expect(screen.getByRole('button', { name: i18n.t('selfPayment.action') })).toBeVisible();
    expect(screen.getByText(i18n.t('dashboard.allActivities'))).toBeVisible();
    expect(screen.getByRole('heading', { name: i18n.t('dashboard.groupStatistics.title') })).toBeVisible();
    expect(screen.getByText(i18n.t('dashboard.groupStatistics.intro'))).toBeVisible();
    expect(screen.getByText(i18n.t('dashboard.groupStatistics.bookingCount', { count: 42 }))).toBeVisible();
    expect(screen.getByText(i18n.t('dashboard.groupStatistics.bookingCount', { count: 6 }))).toBeVisible();
    expect(screen.getByRole('img', { name: i18n.t('dashboard.groupStatistics.percentageLabel', { category: 'Getränke', percentage: 100 }) })).toBeVisible();
    expect(screen.queryByText(i18n.t('booking.quickTitle'))).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: i18n.t('booking.submit') })).not.toBeInTheDocument();
    expect(mocks.getCategories).not.toHaveBeenCalled();
  });

  it('hides the self-payment action when the active membership has no effective permission', async () => {
    const activeGroup = {
      ...demoSession.groups[0],
      membership: { id: 'member-regular', roles: ['MEMBER'] as GroupRole[], groupPermissions: [] },
    };
    mocks.useActiveGroup.mockReturnValue({ activeGroupId: activeGroup.id, activeGroup, session: { ...demoSession, groups: [activeGroup] } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<QueryClientProvider client={queryClient}><DashboardPage /></QueryClientProvider>);

    expect(await screen.findByText(i18n.t('dashboard.paymentNote'))).toBeVisible();
    expect(screen.queryByRole('button', { name: i18n.t('selfPayment.action') })).not.toBeInTheDocument();
  });
});
