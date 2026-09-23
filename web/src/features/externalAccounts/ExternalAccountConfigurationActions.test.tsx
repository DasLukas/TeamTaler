import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalAccount, ExternalAccountCollection, PaymentMethod } from '@/api/types';
import { ExternalAccountConfigurationActions } from './ExternalAccountConfigurationActions';

const mocks = vi.hoisted(() => ({
  deleteExternalAccount: vi.fn(),
  getExternalAccountLinks: vi.fn(),
  reactivateExternalAccount: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: {
  deleteExternalAccount: mocks.deleteExternalAccount,
  getExternalAccountLinks: mocks.getExternalAccountLinks,
  reactivateExternalAccount: mocks.reactivateExternalAccount,
} }));

const paymentMethods: PaymentMethod[] = [{ id: 'CASH', label: 'Bar', attachmentMode: 'OFF', paymentTarget: null }];

function archivedAccount(overrides: Partial<ExternalAccount>): ExternalAccount {
  return {
    id: 'exa-archived',
    name: 'Alte Kasse',
    type: 'CASH',
    status: 'ARCHIVED',
    currency: 'EUR',
    balance: { minorUnits: '0', currency: 'EUR' },
    details: null,
    linkedPaymentMethodIds: [],
    sortOrder: 0,
    version: 1,
    hasTransactions: true,
    canChangeType: false,
    canDelete: true,
    canArchive: false,
    canReactivate: true,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

function renderActions(accounts: ExternalAccountCollection): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  render(<ExternalAccountConfigurationActions accounts={accounts} currency="EUR" groupId="group-a" paymentMethods={paymentMethods} />, { wrapper });
  return client;
}

describe('ExternalAccountConfigurationActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getExternalAccountLinks.mockResolvedValue({ links: [{ paymentMethodId: 'CASH', externalAccountId: null }], version: 7 });
    mocks.deleteExternalAccount.mockResolvedValue({ items: [], version: 8 });
    mocks.reactivateExternalAccount.mockResolvedValue({ items: [], version: 8 });
  });

  it('deletes a balanced historical account only after an explicit irreversible-history confirmation', async () => {
    const user = userEvent.setup();
    renderActions({ version: 7, items: [archivedAccount({})] });

    await user.click(await screen.findByRole('button', { name: 'Konto löschen' }));

    expect(screen.getByRole('heading', { name: 'Konto löschen?' })).toBeVisible();
    expect(screen.getByText(/Bereits erfasste Buchungen bleiben im Verlauf sichtbar/)).toBeVisible();
    expect(screen.getByText(/kann nicht rückgängig gemacht werden/)).toBeVisible();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Konto löschen' }));
    expect(mocks.deleteExternalAccount).toHaveBeenCalledWith('group-a', 'exa-archived', 7);
  });

  it('offers reactivation instead of deletion while an archived account has a remaining balance', async () => {
    const user = userEvent.setup();
    renderActions({ version: 7, items: [archivedAccount({ id: 'exa-balance', name: 'Barkasse Vereinsheim', balance: { minorUnits: '5200', currency: 'EUR' }, canDelete: false })] });

    await user.click(await screen.findByRole('button', { name: 'Konto löschen' }));

    expect(screen.getByRole('heading', { name: 'Konto noch nicht löschbar' })).toBeVisible();
    expect(screen.getByText(/Vor dem Löschen muss der Kontostand 0,00 € sein/)).toBeVisible();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/52,00/)).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Konto löschen' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Konto reaktivieren' }));
    expect(mocks.reactivateExternalAccount).toHaveBeenCalledWith('group-a', 'exa-balance', 7);
    expect(mocks.deleteExternalAccount).not.toHaveBeenCalled();
  });
});
