import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/api/types';
import { ActiveGroupContext } from '@/app/active-group-context';
import i18n from '@/i18n';
import { SelfPaymentDialog } from './SelfPaymentDialog';

const apiMock = vi.hoisted(() => ({ createOwnPayment: vi.fn(), getTransactionSettings: vi.fn() }));

vi.mock('@/api/client', () => ({ api: apiMock }));

const session: Session = {
  user: { id: 'user-member', displayName: 'Alex Member', email: 'alex@example.test' },
  groups: [{
    id: 'group-a',
    name: 'Group A',
    currency: 'EUR',
    defaultTheme: 'TEAMTALER',
    membership: { id: 'member-a', roles: ['MEMBER'], groupPermissions: ['SELF_RECORD_PAYMENT'], themeOverride: null },
  }],
  activeGroupId: 'group-a',
  defaultGroupId: null,
  colorMode: 'SYSTEM',
  systemRoles: [],
};

/**
 * Renders the reusable self-payment flow with authenticated group context.
 *
 * @returns The query client used to observe invalidation behavior.
 */
function renderDialog(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ActiveGroupContext.Provider value={{ session, activeGroup: session.groups[0], activeGroupId: 'group-a', setActiveGroupId: vi.fn() }}>
        {children}
      </ActiveGroupContext.Provider>
    </QueryClientProvider>
  );
  render(<SelfPaymentDialog openBalance={{ minorUnits: '2340', currency: 'EUR' }} />, { wrapper });
  return queryClient;
}

describe('SelfPaymentDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getTransactionSettings.mockResolvedValue({
      foreignBookingReasonRequired: true,
      ownPaymentReasonRequired: true,
      otherPaymentReasonRequired: false,
      paymentMethods: [{ id: 'PAYPAL', label: 'PayPal' }, { id: 'CASH', label: 'Bar' }],
      bookingReasons: [],
      paymentReasons: [{ id: 'MEMBERSHIP', label: 'Membership fee August' }],
    });
  });

  it('reviews and records the open balance without a membership identifier', async () => {
    const user = userEvent.setup();
    const queryClient = renderDialog();
    const invalidations = vi.spyOn(queryClient, 'invalidateQueries');
    apiMock.createOwnPayment.mockResolvedValue({
      id: 'payment-self',
      membershipId: 'member-a',
      memberName: 'Alex Member',
      amount: { minorUnits: '2340', currency: 'EUR' },
      receivedAt: '2026-08-06T00:00:00Z',
      method: 'PAYPAL',
      reference: 'Membership fee August',
      status: 'POSTED',
    });

    await waitFor(() => expect(screen.getByRole('button', { name: i18n.t('selfPayment.action') })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.action') }));
    const entryDialog = screen.getByRole('dialog', { name: i18n.t('selfPayment.entryTitle') });
    expect(entryDialog).toBeVisible();
    expect(within(entryDialog).queryByText(i18n.t('selfPayment.account'))).not.toBeInTheDocument();
    expect(within(entryDialog).queryByText('Group A')).not.toBeInTheDocument();
    expect(screen.getByLabelText(i18n.t('finance.paymentType'))).toHaveValue('PAYPAL');
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.useOpenBalance', { amount: '23,40 €' }) }));
    expect(screen.getByLabelText(i18n.t('finance.amountIn', { currency: 'EUR' }))).toHaveValue('23,40');
    await user.selectOptions(screen.getByLabelText(i18n.t('finance.paymentType')), 'PAYPAL');
    await user.type(screen.getByLabelText(`${i18n.t('finance.reason')} *`), 'Membership fee August');
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.review') }));

    expect(screen.getByRole('dialog', { name: i18n.t('selfPayment.reviewTitle') })).toBeVisible();
    expect(screen.getByText(/23,40/, { selector: 'strong[data-financial-state="payment"]' })).toBeVisible();
    expect(screen.getByText(i18n.t('finance.paypal'))).toBeVisible();
    expect(screen.getByText('Membership fee August')).toBeVisible();
    queryClient.setQueryData(['dashboard', 'group-a'], { openBalance: { minorUnits: '-250', currency: 'EUR' } });
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.confirm', { amount: '23,40 €' }) }));

    await waitFor(() => expect(apiMock.createOwnPayment).toHaveBeenCalledOnce());
    expect(apiMock.createOwnPayment).toHaveBeenCalledWith('group-a', expect.objectContaining({
      amount: { minorUnits: '2340', currency: 'EUR' },
      method: 'PAYPAL',
      reference: 'Membership fee August',
    }));
    expect(apiMock.createOwnPayment.mock.calls[0]?.[1]).not.toHaveProperty('membershipId');
    expect(await screen.findByRole('dialog', { name: i18n.t('selfPayment.successTitle') })).toBeVisible();
    expect(screen.getByText(/-2,50/, { selector: 'strong[data-financial-state="credit"]' })).toBeVisible();
    expect(invalidations).toHaveBeenCalledWith({ queryKey: ['dashboard', 'group-a'] });
    expect(invalidations).toHaveBeenCalledWith({ queryKey: ['ledger', 'group-a'] });
    expect(invalidations).toHaveBeenCalledWith({ queryKey: ['settlements', 'group-a'] });
  });

  it('keeps reviewed values available after a network error', async () => {
    const user = userEvent.setup();
    apiMock.createOwnPayment.mockRejectedValue(new Error('Network unavailable'));
    renderDialog();

    await waitFor(() => expect(screen.getByRole('button', { name: i18n.t('selfPayment.action') })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.action') }));
    await user.type(screen.getByLabelText(i18n.t('finance.amountIn', { currency: 'EUR' })), '12,50');
    await user.type(screen.getByLabelText(`${i18n.t('finance.reason')} *`), 'Transfer reference');
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.review') }));
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.confirm', { amount: '12,50 €' }) }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Network unavailable');
    await user.click(screen.getByRole('button', { name: i18n.t('common.back') }));
    expect(screen.getByLabelText(i18n.t('finance.amountIn', { currency: 'EUR' }))).toHaveValue('12,50');
    expect(screen.getByLabelText(`${i18n.t('finance.reason')} *`)).toHaveValue('Transfer reference');
  });

  it('keeps the entry step open when the required reference is blank', async () => {
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() => expect(screen.getByRole('button', { name: i18n.t('selfPayment.action') })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.action') }));
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.useOpenBalance', { amount: '23,40 €' }) }));
    await user.type(screen.getByLabelText(`${i18n.t('finance.reason')} *`), '   ');
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.review') }));

    expect(screen.getByRole('dialog', { name: i18n.t('selfPayment.entryTitle') })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('selfPayment.referenceRequired'));
    expect(apiMock.createOwnPayment).not.toHaveBeenCalled();
  });

  it('keeps an optional reason editable and offers configured suggestions', async () => {
    const user = userEvent.setup();
    apiMock.getTransactionSettings.mockResolvedValue({
      foreignBookingReasonRequired: true,
      ownPaymentReasonRequired: false,
      otherPaymentReasonRequired: false,
      paymentMethods: [{ id: 'CASH', label: 'Bar' }],
      bookingReasons: [],
      paymentReasons: [{ id: 'MONTHLY', label: 'Monatsausgleich' }],
    });
    renderDialog();
    await waitFor(() => expect(screen.getByRole('button', { name: i18n.t('selfPayment.action') })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.action') }));

    const reason = screen.getByLabelText(i18n.t('finance.reason'));
    expect(reason).not.toBeRequired();
    expect(reason).toHaveAttribute('list', 'self-payment-reason-suggestions');
    expect(document.querySelector('option[value="Monatsausgleich"]')).toBeInTheDocument();
  });

  it('hides the own-payment reason when its mode is off', async () => {
    const user = userEvent.setup();
    apiMock.getTransactionSettings.mockResolvedValue({
      ownPaymentReasonMode: 'OFF',
      ownPaymentReasonRequired: false,
      paymentMethods: [{ id: 'CASH', label: 'Bar' }],
      bookingReasons: [],
      paymentReasons: [],
    });
    renderDialog();
    await waitFor(() => expect(screen.getByRole('button', { name: i18n.t('selfPayment.action') })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.action') }));

    expect(screen.queryByLabelText(i18n.t('finance.reason'))).not.toBeInTheDocument();
    expect(screen.queryByLabelText(`${i18n.t('finance.reason')} *`)).not.toBeInTheDocument();
  });

  it('requires and preserves a configured receipt through review and submission', async () => {
    const user = userEvent.setup();
    apiMock.getTransactionSettings.mockResolvedValue({
      ownPaymentReasonMode: 'OFF',
      ownPaymentReasonRequired: false,
      paymentMethods: [{ id: 'SHOPPING', label: 'Einkauf', attachmentMode: 'REQUIRED' }],
      bookingReasons: [],
      paymentReasons: [],
    });
    apiMock.createOwnPayment.mockResolvedValue({
      id: 'payment-receipt', membershipId: 'member-a', memberName: 'Alex Member', membershipStatus: 'ACTIVE',
      amount: { minorUnits: '1250', currency: 'EUR' }, receivedAt: '2026-08-06', method: 'SHOPPING', methodLabel: 'Einkauf', status: 'POSTED',
    });
    renderDialog();

    await waitFor(() => expect(screen.getByRole('button', { name: i18n.t('selfPayment.action') })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.action') }));
    await user.type(screen.getByLabelText(i18n.t('finance.amountIn', { currency: 'EUR' })), '12,50');
    expect(screen.getByRole('button', { name: i18n.t('selfPayment.review') })).toBeDisabled();

    const receipt = new File(['receipt'], 'receipt.pdf', { type: 'application/pdf' });
    const fileInput = document.querySelector<HTMLInputElement>('input[accept*="application/pdf"]');
    expect(fileInput).not.toBeNull();
    await user.upload(fileInput as HTMLInputElement, receipt);
    expect(screen.getByText('receipt.pdf')).toBeVisible();
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.review') }));
    expect(screen.getByRole('dialog', { name: i18n.t('selfPayment.reviewTitle') })).toBeVisible();
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.confirm', { amount: '12,50 €' }) }));

    await waitFor(() => expect(apiMock.createOwnPayment).toHaveBeenCalledWith('group-a', expect.objectContaining({ method: 'SHOPPING' }), receipt));
  });

  it('keeps the payment dialog and its values open when a portaled scan is cancelled', async () => {
    const user = userEvent.setup();
    apiMock.getTransactionSettings.mockResolvedValue({
      ownPaymentReasonMode: 'OFF',
      ownPaymentReasonRequired: false,
      paymentMethods: [{ id: 'SHOPPING', label: 'Einkauf', attachmentMode: 'REQUIRED' }],
      bookingReasons: [],
      paymentReasons: [],
    });
    renderDialog();

    await waitFor(() => expect(screen.getByRole('button', { name: i18n.t('selfPayment.action') })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.action') }));
    const paymentDialog = screen.getByRole('dialog', { name: i18n.t('selfPayment.entryTitle') });
    const amount = within(paymentDialog).getByLabelText(i18n.t('finance.amountIn', { currency: 'EUR' }));
    expect(amount).toHaveAttribute('inputmode', 'decimal');
    expect(amount).toHaveAttribute('type', 'text');
    await user.type(amount, '12,50');
    const scanTrigger = within(paymentDialog).getByRole('button', { name: i18n.t('paymentAttachment.scan') });

    await user.click(scanTrigger);
    const scanner = await screen.findByRole('dialog', { name: i18n.t('documentScanner.title') });
    expect(paymentDialog.contains(scanner)).toBe(false);
    await user.click(within(scanner).getByRole('button', { name: i18n.t('common.cancel') }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: i18n.t('documentScanner.title') })).not.toBeInTheDocument());
    expect(paymentDialog).toBeVisible();
    expect(amount).toHaveValue('12,50');
    expect(scanTrigger).toHaveFocus();
  });
});
