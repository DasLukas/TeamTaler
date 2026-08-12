import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settlement } from '@/api/types';
import i18n from '@/i18n';
import { SettlementsPanel } from './SettlementsPanel';

const mocks = vi.hoisted(() => ({
  closePeriod: vi.fn(),
  getPeriods: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: mocks }));
vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => ({ activeGroupId: 'group-a' }) }));

const history: Settlement[] = [{
  id: 'settlement-a',
  periodId: 'period-a',
  periodLabel: 'Juli 2026',
  membershipId: 'member-a',
  memberName: 'Alex Example',
  email: null,
  dueAt: '2026-08-15',
  amount: { minorUnits: '1000', currency: 'EUR' },
  paidAmount: { minorUnits: '1000', currency: 'EUR' },
  openAmount: { minorUnits: '0', currency: 'EUR' },
  status: 'PAID',
}];

function renderPanel(settlementsEnabled: boolean, settlements: Settlement[] = history) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><SettlementsPanel settlements={settlements} settlementsEnabled={settlementsEnabled} /></QueryClientProvider>);
}

describe('SettlementsPanel feature modes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPeriods.mockResolvedValue([{ id: 'period-open', label: 'August 2026', status: 'OPEN', startsAt: '2026-08-01T00:00:00Z' }]);
  });

  it('renders immutable history without loading or showing an open period when disabled', () => {
    renderPanel(false);

    expect(screen.getByRole('heading', { name: i18n.t('periods.historyTitle') })).toBeVisible();
    expect(screen.getByText('Juli 2026')).toBeVisible();
    expect(screen.queryByText(i18n.t('periods.current'))).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: i18n.t('periods.close') })).not.toBeInTheDocument();
    expect(mocks.getPeriods).not.toHaveBeenCalled();
  });

  it('restores the open period and close action when enabled', async () => {
    renderPanel(true);

    expect(await screen.findByText(i18n.t('periods.current'))).toBeVisible();
    expect(screen.getByRole('button', { name: i18n.t('periods.close') })).toBeVisible();
    expect(screen.getByRole('heading', { name: i18n.t('periods.title') })).toBeVisible();
  });
});
