import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalAccount } from '@/api/types';
import { ExternalTransactionDialog } from './ExternalTransactionDialog';

const mocks = vi.hoisted(() => ({ createExternalAccountTransaction: vi.fn() }));
vi.mock('@/api/client', () => ({ api: mocks }));

const accounts: ExternalAccount[] = [
  {
    id: 'account-bank', name: 'Association bank', type: 'BANK', status: 'ACTIVE', currency: 'EUR',
    balance: { minorUnits: '10000', currency: 'EUR' }, details: { type: 'BANK', recipientName: '••••', iban: '••••3000' },
    linkedPaymentMethodIds: ['BANK_TRANSFER'], sortOrder: 0, version: 1, hasTransactions: true, canChangeType: false,
    canDelete: false, canArchive: true, canReactivate: false, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
  },
  {
    id: 'account-cash', name: 'Club cash', type: 'CASH', status: 'ACTIVE', currency: 'EUR',
    balance: { minorUnits: '5000', currency: 'EUR' }, details: null,
    linkedPaymentMethodIds: ['CASH'], sortOrder: 1, version: 1, hasTransactions: true, canChangeType: false,
    canDelete: false, canArchive: true, canReactivate: false, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
  },
];

function renderDialog(availableAccounts = accounts): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return render(<ExternalTransactionDialog accounts={availableAccounts} currency="EUR" groupId="group-a" onAccessError={vi.fn()} onClose={vi.fn()} />, { wrapper });
}

describe('ExternalTransactionDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses custom icon menus for flow and account choices', () => {
    const { container } = renderDialog();
    const kindMenu = screen.getByRole('combobox', { name: /^Vorgang/ });

    expect(kindMenu.tagName).toBe('BUTTON');
    expect(container.querySelector('select')).not.toBeInTheDocument();
    fireEvent.click(kindMenu);

    const transferOption = screen.getByRole('option', { name: 'Umbuchung' });
    expect(transferOption.querySelector('svg')).toBeInTheDocument();
    fireEvent.click(transferOption);

    const sourceMenu = screen.getByRole('combobox', { name: /^Quellkonto/ });
    const destinationMenu = screen.getByRole('combobox', { name: /^Zielkonto/ });
    expect(sourceMenu.tagName).toBe('BUTTON');
    expect(destinationMenu.tagName).toBe('BUTTON');
    expect(sourceMenu).toHaveTextContent('Association bank');
    expect(destinationMenu).toHaveTextContent('Club cash');

    fireEvent.click(destinationMenu);
    const cashOption = screen.getByRole('option', { name: 'Club cash' });
    expect(cashOption.querySelector('svg')).toBeInTheDocument();
    expect(cashOption).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'Association bank' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('selects another destination when the transfer source changes', async () => {
    mocks.createExternalAccountTransaction.mockResolvedValueOnce({ id: 'ext-transfer' });
    renderDialog();
    fireEvent.click(screen.getByRole('combobox', { name: /^Vorgang/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Umbuchung' }));
    fireEvent.click(screen.getByRole('combobox', { name: /^Quellkonto/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Club cash' }));

    expect(screen.getByRole('combobox', { name: /^Quellkonto/ })).toHaveTextContent('Club cash');
    expect(screen.getByRole('combobox', { name: /^Zielkonto/ })).toHaveTextContent('Association bank');
    fireEvent.change(screen.getByLabelText(/^Betrag/), { target: { value: '2,50' } });
    fireEvent.change(screen.getByLabelText(/^Kurzbegründung/), { target: { value: 'Cash transfer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(mocks.createExternalAccountTransaction).toHaveBeenCalledWith('group-a', expect.objectContaining({
      kind: 'TRANSFER', sourceAccountId: 'account-cash', destinationAccountId: 'account-bank',
    }), undefined));
  });

  it('offers transfers only when two active accounts are available', () => {
    const availableAccounts: ExternalAccount[] = [{ ...accounts[0], status: 'ARCHIVED' }, accounts[1]];
    renderDialog(availableAccounts);

    expect(screen.getByRole('combobox', { name: /^Zielkonto/ })).toHaveTextContent('Club cash');
    fireEvent.click(screen.getByRole('combobox', { name: /^Vorgang/ }));
    expect(screen.queryByRole('option', { name: 'Umbuchung' })).not.toBeInTheDocument();
  });

  it('reuses the optional receipt picker and submits the selected attachment', async () => {
    mocks.createExternalAccountTransaction.mockResolvedValueOnce({ id: 'ext-created' });
    const { container } = renderDialog();
    fireEvent.change(screen.getByLabelText(/^Betrag/), { target: { value: '2,50' } });
    fireEvent.change(screen.getByLabelText(/^Kurzbegründung/), { target: { value: 'Donation' } });
    const file = new File(['receipt'], 'receipt.pdf', { type: 'application/pdf' });
    const fileInput = container.querySelector<HTMLInputElement>('input[accept*="application/pdf"]');
    expect(fileInput).not.toBeNull();
    expect(fileInput).not.toBeRequired();
    fireEvent.change(fileInput!, { target: { files: [file] } });

    expect(screen.getByText('Beleg')).toBeVisible();
    expect(screen.getByText('receipt.pdf')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen' }));
    expect(screen.getByText('receipt.pdf')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(mocks.createExternalAccountTransaction).toHaveBeenCalledWith('group-a', expect.objectContaining({ amountMinor: 250, reason: 'Donation' }), file));
  });
});
