import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api/client';
import type { ExternalAccount, PaymentMethod } from '@/api/types';
import { ExternalAccountDialog } from './ExternalAccountDialog';

vi.mock('@/api/client', () => ({ api: { createExternalAccount: vi.fn(), getExternalAccountLinks: vi.fn(), updateExternalAccount: vi.fn(), updateExternalAccountLinks: vi.fn() } }));

const paymentMethods: PaymentMethod[] = [
  { id: 'BANK_TRANSFER', label: 'Überweisung', attachmentMode: 'OFF', externalAccountId: 'exa-1', paymentTarget: null },
  { id: 'CASH', label: 'Bar', attachmentMode: 'OFF', externalAccountId: null, paymentTarget: null },
];

const baseAccount: ExternalAccount = {
  id: 'exa-1', name: 'Existing account', type: 'BANK', status: 'ACTIVE', currency: 'EUR',
  balance: { minorUnits: '0', currency: 'EUR' }, details: { type: 'BANK', recipientName: '••••', iban: '••••3000', bic: '••••' },
  linkedPaymentMethodIds: [], sortOrder: 0, version: 1, hasTransactions: false, canChangeType: true,
  canDelete: true, canArchive: true, canReactivate: false, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};

function renderDialog(account: ExternalAccount, onClose = vi.fn()): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  render(<ExternalAccountDialog account={account} collectionVersion={3} currency="EUR" groupId="group-a" onAccessError={vi.fn()} onClose={onClose} paymentMethods={paymentMethods} />, { wrapper });
}

describe('ExternalAccountDialog', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('uses the icon-supported custom menu for account types', () => {
    renderDialog({ ...baseAccount, type: 'CASH', details: null });

    const typeMenu = screen.getByRole('combobox', { name: /^Kontotyp/ });
    expect(typeMenu.tagName).toBe('BUTTON');
    expect(document.querySelector('select')).not.toBeInTheDocument();

    fireEvent.click(typeMenu);
    const bankOption = screen.getByRole('option', { name: 'Bankkonto' });
    expect(bankOption.querySelector('svg')).toBeInTheDocument();
    fireEvent.click(bankOption);
    expect(typeMenu).toHaveTextContent('Bankkonto');
  });

  it('accepts unchanged masked bank fields for a name-only edit', () => {
    renderDialog(baseAccount);
    fireEvent.change(screen.getByLabelText(/^Kontoname/), { target: { value: 'Renamed bank' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen' }));
    expect(screen.getByText('Prüfe die Kontodaten vor dem Speichern.')).toBeVisible();
  });

  it('accepts an unchanged masked PayPal handle for a name-only edit', () => {
    renderDialog({ ...baseAccount, type: 'PAYPAL', details: { type: 'PAYPAL', paypalMeHandle: '••••' } });
    fireEvent.change(screen.getByLabelText(/^Kontoname/), { target: { value: 'Renamed PayPal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen' }));
    expect(screen.getByText('Prüfe die Kontodaten vor dem Speichern.')).toBeVisible();
  });

  it('edits payment-method links through the account multi-select', async () => {
    const onClose = vi.fn();
    vi.mocked(api.updateExternalAccount).mockResolvedValue({ items: [{ ...baseAccount, linkedPaymentMethodIds: ['BANK_TRANSFER'] }], version: 4 });
    vi.mocked(api.getExternalAccountLinks).mockResolvedValue({
      links: [
        { paymentMethodId: 'BANK_TRANSFER', externalAccountId: 'exa-1' },
        { paymentMethodId: 'CASH', externalAccountId: null },
      ],
      version: 7,
    });
    vi.mocked(api.updateExternalAccountLinks).mockResolvedValue({
      links: paymentMethods.map((method) => ({ paymentMethodId: method.id, externalAccountId: 'exa-1' })),
      version: 8,
    });
    renderDialog({ ...baseAccount, linkedPaymentMethodIds: ['BANK_TRANSFER'] }, onClose);

    fireEvent.click(screen.getByRole('button', { name: 'Verknüpfte Zahlungsarten' }));
    const menu = screen.getByRole('dialog', { name: 'Verknüpfte Zahlungsarten' });
    fireEvent.click(within(menu).getByLabelText('Bar'));
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen' }));
    expect(screen.getByText('Überweisung, Bar')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await waitFor(() => expect(api.updateExternalAccountLinks).toHaveBeenCalledWith('group-a', {
      links: [
        { paymentMethodId: 'BANK_TRANSFER', externalAccountId: 'exa-1' },
        { paymentMethodId: 'CASH', externalAccountId: 'exa-1' },
      ],
      version: 7,
    }));
    expect(onClose).toHaveBeenCalled();
  });
});
