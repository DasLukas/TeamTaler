import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/api/types';
import { ActiveGroupContext } from '@/app/active-group-context';
import i18n from '@/i18n';
import { SelfPaymentDialog } from './SelfPaymentDialog';

const apiMock = vi.hoisted(() => ({ createOwnPayment: vi.fn() }));

vi.mock('@/api/client', () => ({ api: apiMock }));

const session: Session = {
  user: { id: 'user-member', displayName: 'Alex Member', email: 'alex@example.test' },
  groups: [{
    id: 'group-a',
    name: 'Group A',
    currency: 'EUR',
    membership: { id: 'member-a', roles: ['MEMBER'], groupPermissions: ['SELF_RECORD_PAYMENT'] },
  }],
  activeGroupId: 'group-a',
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
  beforeEach(() => vi.clearAllMocks());

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

    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.action') }));
    expect(screen.getByRole('dialog', { name: i18n.t('selfPayment.entryTitle') })).toBeVisible();
    expect(screen.getByText('Alex Member')).toBeVisible();
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.useOpenBalance', { amount: '23,40 €' }) }));
    expect(screen.getByLabelText(i18n.t('finance.amountIn', { currency: 'EUR' }))).toHaveValue('23,40');
    await user.selectOptions(screen.getByLabelText(i18n.t('finance.paymentType')), 'PAYPAL');
    await user.type(screen.getByLabelText(i18n.t('common.reference')), 'Membership fee August');
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.review') }));

    expect(screen.getByRole('dialog', { name: i18n.t('selfPayment.reviewTitle') })).toBeVisible();
    expect(screen.getByText(i18n.t('finance.paypal'))).toBeVisible();
    expect(screen.getByText('Membership fee August')).toBeVisible();
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.confirm', { amount: '23,40 €' }) }));

    await waitFor(() => expect(apiMock.createOwnPayment).toHaveBeenCalledOnce());
    expect(apiMock.createOwnPayment).toHaveBeenCalledWith('group-a', expect.objectContaining({
      amount: { minorUnits: '2340', currency: 'EUR' },
      method: 'PAYPAL',
      reference: 'Membership fee August',
    }));
    expect(apiMock.createOwnPayment.mock.calls[0]?.[1]).not.toHaveProperty('membershipId');
    expect(await screen.findByRole('dialog', { name: i18n.t('selfPayment.successTitle') })).toBeVisible();
    expect(invalidations).toHaveBeenCalledWith({ queryKey: ['dashboard', 'group-a'] });
    expect(invalidations).toHaveBeenCalledWith({ queryKey: ['ledger', 'group-a'] });
    expect(invalidations).toHaveBeenCalledWith({ queryKey: ['settlements', 'group-a'] });
  });

  it('keeps reviewed values available after a network error', async () => {
    const user = userEvent.setup();
    apiMock.createOwnPayment.mockRejectedValue(new Error('Network unavailable'));
    renderDialog();

    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.action') }));
    await user.type(screen.getByLabelText(i18n.t('finance.amountIn', { currency: 'EUR' })), '12,50');
    await user.type(screen.getByLabelText(i18n.t('common.reference')), 'Transfer reference');
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.review') }));
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.confirm', { amount: '12,50 €' }) }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Network unavailable');
    await user.click(screen.getByRole('button', { name: i18n.t('common.back') }));
    expect(screen.getByLabelText(i18n.t('finance.amountIn', { currency: 'EUR' }))).toHaveValue('12,50');
    expect(screen.getByLabelText(i18n.t('common.reference'))).toHaveValue('Transfer reference');
  });

  it('keeps the entry step open when the required reference is blank', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.action') }));
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.useOpenBalance', { amount: '23,40 €' }) }));
    await user.type(screen.getByLabelText(i18n.t('common.reference')), '   ');
    await user.click(screen.getByRole('button', { name: i18n.t('selfPayment.review') }));

    expect(screen.getByRole('dialog', { name: i18n.t('selfPayment.entryTitle') })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('selfPayment.referenceRequired'));
    expect(apiMock.createOwnPayment).not.toHaveBeenCalled();
  });
});
