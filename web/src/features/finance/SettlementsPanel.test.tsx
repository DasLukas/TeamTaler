import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSummary, Settlement } from '@/api/types';
import modalStyles from '@/components/ui/Modal.module.css';
import i18n from '@/i18n';
import { SettlementsPanel } from './SettlementsPanel';

const mocks = vi.hoisted(() => ({
  closePeriod: vi.fn(),
  getAccountSummaries: vi.fn(),
  getPeriods: vi.fn(),
}));
const mediaQueryMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({ api: mocks }));
vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => ({ activeGroupId: 'group-a' }) }));
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: (query: string) => mediaQueryMock(query) }));

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

const account: AccountSummary = {
  membershipId: 'member-a',
  displayName: 'Alex Example',
  avatarUrl: '/avatars/alex-example.png',
  isTemporaryGuest: false,
  status: 'ACTIVE',
  currency: 'EUR',
  balance: { minorUnits: '0', currency: 'EUR' },
};

function renderPanel(settlementsEnabled: boolean, settlements: Settlement[] = history) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><SettlementsPanel settlements={settlements} settlementsEnabled={settlementsEnabled} /></QueryClientProvider>);
}

describe('SettlementsPanel feature modes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mediaQueryMock.mockReturnValue(false);
    mocks.getAccountSummaries.mockResolvedValue([account]);
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

  it('renders the period-close workflow as a bottom sheet on compact screens', async () => {
    const user = userEvent.setup();
    mediaQueryMock.mockReturnValue(true);
    renderPanel(true);

    await user.click(await screen.findByRole('button', { name: i18n.t('periods.close') }));

    const sheet = screen.getByRole('dialog', { name: i18n.t('periods.closeDialog') });
    expect(mediaQueryMock).toHaveBeenCalledWith('(max-width: 600px)');
    expect(sheet).toHaveClass(modalStyles.sheet);
    expect(sheet.querySelector(`button[aria-label="${i18n.t('dialog.sheetHandle')}"]`)).toBeInTheDocument();
  });

  it('filters settlement balance states with a visual multi-select menu', async () => {
    const user = userEvent.setup();
    renderPanel(false);

    await user.click(screen.getByRole('button', { name: i18n.t('dataTable.filterButton') }));
    const filterDialog = screen.getByRole('dialog', { name: i18n.t('dataTable.filterHeading') });
    const memberTrigger = within(filterDialog).getByRole('combobox', { name: i18n.t('common.member') });
    await user.click(memberTrigger);
    const memberListbox = screen.getByRole('listbox', { name: i18n.t('common.member') });
    expect(within(memberListbox).getByRole('option', { name: 'Alex Example' }).querySelector('img')).toHaveAttribute('src', '/avatars/alex-example.png');
    await user.keyboard('{Escape}');
    const balanceStateTrigger = within(filterDialog).getByRole('button', { name: i18n.t('financeWorkspace.balanceState') });
    await user.click(balanceStateTrigger);

    const balanceStateMenu = screen.getByRole('dialog', { name: i18n.t('financeWorkspace.balanceState') });
    expect(balanceStateMenu.querySelectorAll('svg')).toHaveLength(4);
    await user.click(within(balanceStateMenu).getByRole('checkbox', { name: i18n.t('common.open') }));
    await user.click(within(balanceStateMenu).getByRole('checkbox', { name: i18n.t('common.paid') }));
    await user.keyboard('{Escape}');
    await user.click(within(filterDialog).getByRole('button', { name: i18n.t('dataTable.applyFilters') }));

    const chips = screen.getByRole('list', { name: i18n.t('dataTable.filterHeading') });
    expect(chips).toHaveTextContent(`${i18n.t('financeWorkspace.balanceState')}:`);
    expect(chips).toHaveTextContent(`${i18n.t('common.open')}, ${i18n.t('common.paid')}`);
    expect(screen.getByRole('columnheader', { name: i18n.t('financeWorkspace.balanceState') })).toBeVisible();
  });
});
