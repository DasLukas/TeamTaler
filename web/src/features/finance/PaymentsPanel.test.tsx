import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
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
  { membershipId: 'member-active', displayName: 'Active Account', status: 'ACTIVE', currency: 'EUR', balance: { minorUnits: '0', currency: 'EUR' } },
  { membershipId: 'member-archived', displayName: 'Archived Account', status: 'ARCHIVED', currency: 'EUR', balance: { minorUnits: '500', currency: 'EUR' } },
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

    expect(screen.getByRole('option', { name: 'Active Account' })).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Archived Account' })).not.toBeInTheDocument();
  });
});
