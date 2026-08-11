import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSummary } from '@/api/types';
import i18n from '@/i18n';
import { PaymentsPanel } from './PaymentsPanel';

const apiMock = vi.hoisted(() => ({
  getPayments: vi.fn(),
  getAccountSummaries: vi.fn(),
  createPayment: vi.fn(),
  reversePayment: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: apiMock }));
vi.mock('@/app/useActiveGroup', () => ({
  useActiveGroup: () => ({ activeGroupId: 'group-a', activeGroup: { currency: 'EUR' } }),
}));

const accounts: AccountSummary[] = [
  { membershipId: 'member-active', displayName: 'Active Account', isTemporaryGuest: false, status: 'ACTIVE', currency: 'EUR', balance: { minorUnits: '0', currency: 'EUR' } },
  { membershipId: 'member-guest', displayName: 'Temporary Guest', isTemporaryGuest: true, status: 'ACTIVE', currency: 'EUR', balance: { minorUnits: '100', currency: 'EUR' } },
  { membershipId: 'member-archived', displayName: 'Archived Account', isTemporaryGuest: false, status: 'ARCHIVED', currency: 'EUR', balance: { minorUnits: '500', currency: 'EUR' } },
  { membershipId: 'member-deleted', displayName: 'Deleted Account', isTemporaryGuest: false, status: 'DELETED', currency: 'EUR', balance: { minorUnits: '250', currency: 'EUR' } },
  { membershipId: 'member-deleted-credit', displayName: 'Deleted Credit', isTemporaryGuest: false, status: 'DELETED', currency: 'EUR', balance: { minorUnits: '-100', currency: 'EUR' } },
];

function renderPayments(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  render(<PaymentsPanel />, { wrapper });
}

describe('PaymentsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getPayments.mockResolvedValue([]);
    apiMock.getAccountSummaries.mockResolvedValue(accounts);
  });

  it('uses finance account summaries without requesting the protected member directory', async () => {
    const user = userEvent.setup();
    renderPayments();

    await waitFor(() => expect(apiMock.getAccountSummaries).toHaveBeenCalledWith('group-a'));
    await user.click((await screen.findAllByRole('button', { name: i18n.t('finance.record') }))[0]);

    const accountSelect = screen.getByLabelText(i18n.t('common.member'));
    const groups = within(accountSelect).getAllByRole('group');
    expect(groups).toHaveLength(4);
    expect(groups[0]).toHaveAttribute('label', i18n.t('booking.regularMembers'));
    expect(within(groups[0]).getByRole('option', { name: 'Active Account' })).toBeVisible();
    expect(groups[1]).toHaveAttribute('label', i18n.t('booking.guests'));
    expect(within(groups[1]).getByRole('option', { name: 'Temporary Guest' })).toBeVisible();
    expect(groups[2]).toHaveAttribute('label', i18n.t('financeWorkspace.archivedMembers'));
    expect(within(groups[2]).getByRole('option', { name: 'Archived Account' })).toBeVisible();
    expect(groups[3]).toHaveAttribute('label', i18n.t('financeWorkspace.deletedAccounts'));
    expect(within(groups[3]).getByRole('option', { name: 'Deleted Account' })).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Deleted Credit' })).not.toBeInTheDocument();
  });
});
