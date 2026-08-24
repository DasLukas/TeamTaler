import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { demoAccountSummaries, demoSession } from '@/demo/data';
import i18n from '@/i18n';
import { AccountBalancesPanel } from './AccountBalancesPanel';

const mocks = vi.hoisted(() => ({ getAccountSummaries: vi.fn(), useActiveGroup: vi.fn() }));

vi.mock('@/api/client', () => ({ api: { getAccountSummaries: mocks.getAccountSummaries } }));
vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => mocks.useActiveGroup() }));

describe('AccountBalancesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/finance');
    mocks.getAccountSummaries.mockResolvedValue(demoAccountSummaries);
    mocks.useActiveGroup.mockReturnValue({ activeGroupId: 'group-sv-adler', activeGroup: demoSession.groups[0] });
  });

  it('shows exact summary amounts and membership lifecycle values in one sortable table', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><AccountBalancesPanel /></QueryClientProvider>);

    const receivables = (await screen.findByText(i18n.t('financeWorkspace.receivables'))).closest('article');
    const credits = screen.getAllByText(i18n.t('financeWorkspace.credits'))[0].closest('article');
    const net = screen.getByText(i18n.t('financeWorkspace.netBalance')).closest('article');
    expect(within(receivables as HTMLElement).getByText(/28,40/)).toBeVisible();
    expect(within(credits as HTMLElement).getByText(/2,50/)).toBeVisible();
    expect(within(net as HTMLElement).getByText(/25,90/)).toBeVisible();
    const table = screen.getByRole('table', { name: i18n.t('financeWorkspace.overviewTitle') });
    expect(within(table).getAllByText(i18n.t('financeWorkspace.active')).length).toBeGreaterThan(0);
    expect(within(table).getByText(i18n.t('financeWorkspace.archived'))).toBeVisible();
    expect(screen.getAllByText('Pia Lehmann').length).toBeGreaterThan(0);
  });

  it('filters all membership statuses by display name', async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><AccountBalancesPanel /></QueryClientProvider>);

    await screen.findByText(i18n.t('financeWorkspace.receivables'));
    await user.type(screen.getByRole('searchbox', { name: i18n.t('financeWorkspace.search') }), 'Pia');

    expect(screen.queryByText('Lukas Waschul')).not.toBeInTheDocument();
    expect(screen.getAllByText('Pia Lehmann').length).toBeGreaterThan(0);
  });

  it('filters membership and balance states with visual multi-select menus', async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><AccountBalancesPanel /></QueryClientProvider>);

    await screen.findByText(i18n.t('financeWorkspace.receivables'));
    await user.click(screen.getByRole('button', { name: i18n.t('dataTable.filterButton') }));
    const filterDialog = screen.getByRole('dialog', { name: i18n.t('dataTable.filterHeading') });
    const memberTrigger = within(filterDialog).getByRole('combobox', { name: i18n.t('common.member') });
    const membershipTrigger = within(filterDialog).getByRole('button', { name: i18n.t('financeWorkspace.membershipStatus') });
    const balanceStateTrigger = within(filterDialog).getByRole('button', { name: i18n.t('financeWorkspace.balanceState') });
    expect(within(filterDialog).getByRole('spinbutton', { name: i18n.t('dataTable.minimum') })).toHaveAttribute('inputmode', 'decimal');
    expect(within(filterDialog).getByRole('spinbutton', { name: i18n.t('dataTable.maximum') })).toHaveAttribute('inputmode', 'decimal');

    await user.click(memberTrigger);
    const memberMenu = screen.getByRole('listbox', { name: i18n.t('common.member') });
    const piaOption = within(memberMenu).getByRole('option', { name: 'Pia Lehmann' });
    expect(piaOption).toHaveTextContent('PL');
    await user.click(piaOption);

    await user.click(membershipTrigger);
    const membershipMenu = screen.getByRole('dialog', { name: i18n.t('financeWorkspace.membershipStatus') });
    expect(membershipMenu.querySelectorAll('svg')).toHaveLength(3);
    await user.click(within(membershipMenu).getByRole('checkbox', { name: i18n.t('financeWorkspace.archived') }));

    await user.click(balanceStateTrigger);
    const balanceStateMenu = screen.getByRole('dialog', { name: i18n.t('financeWorkspace.balanceState') });
    expect(balanceStateMenu.querySelectorAll('svg')).toHaveLength(3);
    await user.click(within(balanceStateMenu).getByRole('checkbox', { name: i18n.t('financeWorkspace.states.settled') }));
    await user.click(within(filterDialog).getByRole('button', { name: i18n.t('dataTable.applyFilters') }));

    const table = screen.getByRole('table', { name: i18n.t('financeWorkspace.overviewTitle') });
    expect(within(table).getByRole('columnheader', { name: i18n.t('financeWorkspace.balanceState') })).toBeVisible();
    expect(within(table).getByText('Pia Lehmann')).toBeVisible();
    expect(within(table).queryByText('Lukas Waschul')).not.toBeInTheDocument();
  });

  it('keeps deleted accounts in the complete operational table', async () => {
    mocks.getAccountSummaries.mockResolvedValue([...demoAccountSummaries, {
      membershipId: 'member-deleted', displayName: 'Deleted Account', isTemporaryGuest: false, status: 'DELETED',
      currency: 'EUR', balance: { minorUnits: '250', currency: 'EUR' },
    }]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><AccountBalancesPanel /></QueryClientProvider>);

    const table = await screen.findByRole('table', { name: i18n.t('financeWorkspace.overviewTitle') });
    const deletedRow = within(table).getByRole('row', { name: /Deleted Account.*Gelöscht/ });
    expect(deletedRow).toBeVisible();
  });
});
