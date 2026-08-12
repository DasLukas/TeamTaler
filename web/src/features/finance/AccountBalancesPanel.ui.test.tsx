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
    mocks.getAccountSummaries.mockResolvedValue(demoAccountSummaries);
    mocks.useActiveGroup.mockReturnValue({ activeGroupId: 'group-sv-adler', activeGroup: demoSession.groups[0] });
  });

  it('shows exact summary amounts and separates active and archived memberships', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><AccountBalancesPanel /></QueryClientProvider>);

    const receivables = (await screen.findByText(i18n.t('financeWorkspace.receivables'))).closest('article');
    const credits = screen.getAllByText(i18n.t('financeWorkspace.credits'))[0].closest('article');
    const net = screen.getByText(i18n.t('financeWorkspace.netBalance')).closest('article');
    expect(within(receivables as HTMLElement).getByText(/28,40/)).toBeVisible();
    expect(within(credits as HTMLElement).getByText(/2,50/)).toBeVisible();
    expect(within(net as HTMLElement).getByText(/25,90/)).toBeVisible();
    expect(screen.getByRole('heading', { name: /Aktive Mitglieder/ })).toBeVisible();
    expect(screen.getByRole('heading', { name: /Archivierte Mitglieder/ })).toBeVisible();
    expect(screen.getAllByText('Pia Lehmann').length).toBeGreaterThan(0);
  });

  it('filters both status groups by display name', async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><AccountBalancesPanel /></QueryClientProvider>);

    await screen.findByText(i18n.t('financeWorkspace.receivables'));
    await user.type(screen.getByRole('searchbox', { name: i18n.t('financeWorkspace.search') }), 'Pia');

    expect(screen.queryByText('Lukas Waschul')).not.toBeInTheDocument();
    expect(screen.getAllByText('Pia Lehmann').length).toBeGreaterThan(0);
  });

  it('renders deleted accounts in their own operational group', async () => {
    mocks.getAccountSummaries.mockResolvedValue([...demoAccountSummaries, {
      membershipId: 'member-deleted', displayName: 'Deleted Account', isTemporaryGuest: false, status: 'DELETED',
      currency: 'EUR', balance: { minorUnits: '250', currency: 'EUR' },
    }]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><AccountBalancesPanel /></QueryClientProvider>);

    const deletedHeading = await screen.findByRole('heading', { name: /Gelöschte Konten/ });
    const deletedSection = deletedHeading.closest('section');
    expect(within(deletedSection as HTMLElement).getAllByText('Deleted Account').length).toBeGreaterThan(0);
    expect(within(deletedSection as HTMLElement).getAllByText(i18n.t('common.deleted')).length).toBeGreaterThan(0);
  });
});
