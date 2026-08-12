import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { FinancePage } from './FinancePage';

const mocks = vi.hoisted(() => ({
  getSettlements: vi.fn(),
  getTransactionSettings: vi.fn(),
  useActiveGroup: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: { getSettlements: mocks.getSettlements, getTransactionSettings: mocks.getTransactionSettings } }));
vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => mocks.useActiveGroup() }));
vi.mock('./AccountBalancesPanel', () => ({ AccountBalancesPanel: () => <div>account-overview-panel</div> }));
vi.mock('./PaymentsPanel', () => ({ PaymentsPanel: () => <div>payments-panel</div> }));
vi.mock('./SettlementsPanel', () => ({ SettlementsPanel: ({ settlementsEnabled }: { settlementsEnabled: boolean }) => <div>settlements-panel-{String(settlementsEnabled)}</div> }));

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><FinancePage /></QueryClientProvider>);
}

describe('FinancePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettlements.mockResolvedValue([]);
    mocks.getTransactionSettings.mockResolvedValue({ settlementsEnabled: true });
    mocks.useActiveGroup.mockReturnValue({ activeGroupId: 'group-a', activeGroup: { membership: { effectiveGrants: [{ permission: 'FINANCE_MANAGEMENT', scope: { type: 'GROUP' } }] } } });
  });

  it('uses the account overview as the default of three finance tabs', async () => {
    const user = userEvent.setup();
    renderPage();

    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Übersicht', 'Zahlungen', 'Abrechnungen']);
    expect(screen.getByText('account-overview-panel')).toBeVisible();

    await user.click(screen.getByRole('tab', { name: i18n.t('financeWorkspace.tabs.payments') }));
    expect(screen.getByText('payments-panel')).toBeVisible();
    await user.click(screen.getByRole('tab', { name: i18n.t('financeWorkspace.tabs.settlements') }));
    expect(screen.getByText('settlements-panel-true')).toBeVisible();
  });

  it('hides settlement navigation when the feature and history are absent', async () => {
    mocks.getTransactionSettings.mockResolvedValue({ settlementsEnabled: false });
    renderPage();

    expect((await screen.findAllByRole('tab')).map((tab) => tab.textContent)).toEqual(['Übersicht', 'Zahlungen']);
    expect(screen.queryByRole('tab', { name: i18n.t('financeWorkspace.tabs.settlementHistory') })).not.toBeInTheDocument();
  });

  it('keeps immutable settlement history available without close controls when disabled', async () => {
    mocks.getTransactionSettings.mockResolvedValue({ settlementsEnabled: false });
    mocks.getSettlements.mockResolvedValue([{ id: 'settlement-a' }]);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('tab', { name: i18n.t('financeWorkspace.tabs.settlementHistory') }));
    expect(screen.getByText('settlements-panel-false')).toBeVisible();
  });

  it('renders no finance child for an unauthorized membership', () => {
    mocks.useActiveGroup.mockReturnValue({ activeGroupId: 'group-a', activeGroup: { membership: { effectiveGrants: [] } } });
    renderPage();

    expect(screen.getByText(i18n.t('financeWorkspace.noAccessTitle'))).toBeVisible();
    expect(screen.queryByText('account-overview-panel')).not.toBeInTheDocument();
    expect(screen.queryByText('payments-panel')).not.toBeInTheDocument();
    expect(screen.queryByText(/settlements-panel/)).not.toBeInTheDocument();
    expect(mocks.getTransactionSettings).not.toHaveBeenCalled();
    expect(mocks.getSettlements).not.toHaveBeenCalled();
  });
});
