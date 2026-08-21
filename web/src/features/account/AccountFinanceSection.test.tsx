import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { AccountFinanceSection } from './AccountFinanceSection';

const mocks = vi.hoisted(() => ({
  getDashboard: vi.fn(),
  getLedger: vi.fn(),
  getSettlements: vi.fn(),
  getTransactionSettings: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: mocks }));
vi.mock('@/app/useActiveGroup', () => ({
  useActiveGroup: () => ({
    activeGroupId: 'group-a',
    activeGroup: { membership: { id: 'member-a', effectiveGrants: [] } },
  }),
}));

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><AccountFinanceSection /></QueryClientProvider>);
}

describe('AccountFinanceSection settlement visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDashboard.mockResolvedValue({ openBalance: { minorUnits: '0', currency: 'EUR' } });
    mocks.getLedger.mockResolvedValue([]);
    mocks.getSettlements.mockResolvedValue([]);
    mocks.getTransactionSettings.mockResolvedValue({ settlementsEnabled: false });
  });

  it('omits settlement UI when the feature is disabled and no history exists', async () => {
    renderSection();

    expect(await screen.findByRole('heading', { name: i18n.t('account.movements') })).toBeVisible();
    expect(screen.queryByRole('heading', { name: i18n.t('account.closedSettlements') })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: i18n.t('account.settlementHistory') })).not.toBeInTheDocument();
  });

  it('shows matching settlement history read-only while the feature is disabled', async () => {
    mocks.getSettlements.mockResolvedValue([{
      id: 'settlement-a',
      periodId: 'period-a',
      periodLabel: 'Juli 2026',
      membershipId: 'member-a',
      memberName: 'Alex Example',
      dueAt: '2026-08-15',
      amount: { minorUnits: '1000', currency: 'EUR' },
      paidAmount: { minorUnits: '1000', currency: 'EUR' },
      openAmount: { minorUnits: '0', currency: 'EUR' },
      status: 'PAID',
    }]);
    renderSection();

    expect(await screen.findByRole('heading', { name: i18n.t('account.settlementHistory') })).toBeVisible();
    expect(screen.getByText('Juli 2026')).toBeVisible();
  });

  it('keeps the regular settlement section visible when the feature is enabled', async () => {
    mocks.getTransactionSettings.mockResolvedValue({ settlementsEnabled: true });
    renderSection();

    expect(await screen.findByRole('heading', { name: i18n.t('account.closedSettlements') })).toBeVisible();
    expect(screen.getByText(i18n.t('account.noSettlements'))).toBeVisible();
  });

  it('renders transaction kinds in the shared custom multi-select dropdown', async () => {
    const user = userEvent.setup();
    renderSection();

    await screen.findByRole('heading', { name: i18n.t('account.movements') });
    await user.click(screen.getByRole('button', { name: i18n.t('dataTable.filterButton') }));
    const filterDialog = screen.getByRole('dialog', { name: i18n.t('dataTable.filterHeading') });
    await user.click(within(filterDialog).getByRole('button', { name: i18n.t('account.transaction') }));
    const kindMenu = screen.getByRole('dialog', { name: i18n.t('account.transaction') });

    expect(within(kindMenu).getByRole('checkbox', { name: i18n.t('account.kind.booking') })).toBeVisible();
    expect(within(kindMenu).getByRole('checkbox', { name: i18n.t('account.kind.payment') })).toBeVisible();
    expect(within(kindMenu).getByRole('checkbox', { name: i18n.t('account.kind.reversal') })).toBeVisible();
    expect(within(kindMenu).getByRole('checkbox', { name: i18n.t('account.kind.credit') })).toBeVisible();
  });
});
