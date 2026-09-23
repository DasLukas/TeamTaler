import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import type { PermissionKey } from '@/api/types';
import { ExternalAccountsPanel } from './ExternalAccountsPanel';

const mocks = vi.hoisted(() => ({
  getExternalAccounts: vi.fn(),
  getTransactionSettings: vi.fn(),
  permissions: ['VIEW_EXTERNAL_ACCOUNTS'] as PermissionKey[],
}));

vi.mock('@/api/client', () => ({ api: {
  getExternalAccounts: mocks.getExternalAccounts,
  getTransactionSettings: mocks.getTransactionSettings,
}, ApiError: class ApiError extends Error {
  problem: { status: number };
  constructor(problem: { status: number }) { super('API error'); this.problem = problem; }
} }));
vi.mock('@/app/useActiveGroup', () => ({ useActiveGroup: () => ({
  activeGroupId: 'group-a',
  activeGroup: {
    currency: 'EUR',
    externalAccountsEnabled: true,
    membership: { effectiveGrants: mocks.permissions.map((permission) => ({ permission, scope: { type: 'GROUP' } })) },
  },
}) }));
vi.mock('./ExternalTransactionHistory', () => ({ ExternalTransactionHistory: () => <div>transaction-history</div> }));

function renderPanel(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  render(<ExternalAccountsPanel />, { wrapper });
  return queryClient;
}

describe('ExternalAccountsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permissions = ['VIEW_EXTERNAL_ACCOUNTS'];
    mocks.getTransactionSettings.mockResolvedValue({ paymentMethods: [{ id: 'CASH', label: 'Bar', externalAccountId: 'exa-cash' }] });
    mocks.getExternalAccounts.mockResolvedValue({ version: 3, items: [{
      id: 'exa-cash', name: 'Vereinskasse', type: 'CASH', status: 'ACTIVE', currency: 'EUR',
      balance: { minorUnits: '-250', currency: 'EUR' }, details: null, linkedPaymentMethodIds: ['CASH'],
      sortOrder: 0, version: 1, hasTransactions: true, canChangeType: false, canDelete: false,
      canArchive: false, canReactivate: false, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    }] });
  });

  it('shows balances and history without mutation controls to a view-only membership', async () => {
    renderPanel();

    expect(await screen.findByText('Vereinskasse')).toBeVisible();
    const accountCard = screen.getByText('Vereinskasse').closest('article');
    expect(accountCard).toHaveAttribute('data-account-type', 'CASH');
    expect(accountCard).toHaveAttribute('data-balance-tone', 'negative');
    expect(accountCard?.querySelector('[data-account-icon="CASH"]')).toBeInTheDocument();
    expect(screen.queryByText('Negativer Kontostand')).not.toBeInTheDocument();
    expect(screen.getByText('Bar')).toBeVisible();
    expect(screen.getByText('transaction-history')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Konto anlegen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Zahlungsarten verbinden' })).not.toBeInTheDocument();
  });

  it('keeps configuration out of finance and moves transaction creation into the page header', async () => {
    mocks.permissions = ['MANAGE_EXTERNAL_ACCOUNTS'];
    mocks.getExternalAccounts.mockResolvedValue({ version: 3, items: [
      {
        id: 'exa-cash', name: 'Vereinskasse', type: 'CASH', status: 'ACTIVE', currency: 'EUR',
        balance: { minorUnits: '250', currency: 'EUR' }, details: null, linkedPaymentMethodIds: ['CASH'],
        sortOrder: 0, version: 1, hasTransactions: true, canChangeType: false, canDelete: false,
        canArchive: true, canReactivate: false, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
      },
      {
        id: 'exa-old', name: 'Alte Kasse', type: 'CASH', status: 'ARCHIVED', currency: 'EUR',
        balance: { minorUnits: '0', currency: 'EUR' }, details: null, linkedPaymentMethodIds: [],
        sortOrder: 1, version: 1, hasTransactions: true, canChangeType: false, canDelete: false,
        canArchive: false, canReactivate: true, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
      },
    ] });
    renderPanel();

    const recordTransaction = await screen.findByRole('button', { name: 'Finanzfluss erfassen' });
    expect(screen.getByText('Vereinskasse').closest('article')).toHaveAttribute('data-balance-tone', 'positive');
    expect(screen.getByText('Alte Kasse').closest('article')).toHaveAttribute('data-balance-tone', 'neutral');
    expect(recordTransaction).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Konto anlegen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Zahlungsarten verbinden' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bearbeiten' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archivieren' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reaktivieren' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Löschen' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Aktive Konten' })).queryByRole('button', { name: 'Finanzfluss erfassen' })).not.toBeInTheDocument();
  });

  it.each([403, 409])('removes sensitive caches after a %s response', async (status) => {
    mocks.getExternalAccounts.mockRejectedValue(new ApiError({ status, title: 'Access changed', type: 'about:blank' }));
    const queryClient = renderPanel();
    queryClient.setQueryData(['external-accounts', 'group-a', 'transactions', 'cached'], { secret: true });

    expect(await screen.findByText('Du benötigst das Recht, externe Konten einzusehen.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeVisible();
    expect(queryClient.getQueriesData({ queryKey: ['external-accounts', 'group-a'] }).every(([, data]) => data === undefined)).toBe(true);
  });
});
