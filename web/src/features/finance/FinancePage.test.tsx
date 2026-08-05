import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { FinancePage } from './FinancePage';

const mocks = vi.hoisted(() => ({ useActiveGroup: vi.fn() }));

vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => mocks.useActiveGroup() }));
vi.mock('./AccountBalancesPanel', () => ({ AccountBalancesPanel: () => <div>account-overview-panel</div> }));
vi.mock('./PaymentsPanel', () => ({ PaymentsPanel: () => <div>payments-panel</div> }));
vi.mock('./SettlementsPanel', () => ({ SettlementsPanel: () => <div>settlements-panel</div> }));

describe('FinancePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useActiveGroup.mockReturnValue({ activeGroup: { membership: { roles: ['FINANCE_MANAGER', 'MEMBER'] } } });
  });

  it('uses the account overview as the default of three finance tabs', async () => {
    const user = userEvent.setup();
    render(<FinancePage />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Übersicht', 'Zahlungen', 'Abrechnungen']);
    expect(screen.getByText('account-overview-panel')).toBeVisible();

    await user.click(screen.getByRole('tab', { name: i18n.t('financeWorkspace.tabs.payments') }));
    expect(screen.getByText('payments-panel')).toBeVisible();
    await user.click(screen.getByRole('tab', { name: i18n.t('financeWorkspace.tabs.settlements') }));
    expect(screen.getByText('settlements-panel')).toBeVisible();
  });

  it('renders no finance child for an unauthorized membership', () => {
    mocks.useActiveGroup.mockReturnValue({ activeGroup: { membership: { roles: ['MEMBER'] } } });
    render(<FinancePage />);

    expect(screen.getByText(i18n.t('financeWorkspace.noAccessTitle'))).toBeVisible();
    expect(screen.queryByText('account-overview-panel')).not.toBeInTheDocument();
    expect(screen.queryByText('payments-panel')).not.toBeInTheDocument();
    expect(screen.queryByText('settlements-panel')).not.toBeInTheDocument();
  });
});
