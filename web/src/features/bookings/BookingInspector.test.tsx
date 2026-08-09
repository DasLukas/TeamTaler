import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { BookingTarget, Period, Product } from '@/api/types';
import i18n from '@/i18n';
import { BookingInspector } from './BookingInspector';

const apiMock = vi.hoisted(() => ({ createBookings: vi.fn() }));

vi.mock('@/api/client', () => ({ api: apiMock }));

const product: Product = {
  id: 'product-water',
  categoryId: 'category-drinks',
  version: 1,
  name: 'Water',
  pricingMode: 'FIXED',
  currency: 'EUR',
  price: { minorUnits: '100', currency: 'EUR' },
  active: true,
  sortOrder: 0,
};

const period: Period = {
  id: 'period-current',
  label: 'Current',
  status: 'OPEN',
  startsAt: '2026-08-01T00:00:00Z',
};

const targets: BookingTarget[] = [
  {
    membershipId: 'member-actor',
    displayName: 'Assigning Member',
    isTemporaryGuest: false,
  },
  {
    membershipId: 'member-target',
    displayName: 'Target Member',
    isTemporaryGuest: false,
  },
];

function renderInspector(selectedProduct: Product = product, canBookForGuests = false): void {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  render(
    <BookingInspector
      canBookForGuests={canBookForGuests}
      currentMembershipId="member-actor"
      groupId="group-a"
      onCancel={vi.fn()}
      period={period}
      product={selectedProduct}
      targets={targets}
    />,
    { wrapper },
  );
}

describe('BookingInspector category-neutral booking rules', () => {
  it('releases the selected product for another booking after showing confirmation', async () => {
    const user = userEvent.setup();
    apiMock.createBookings.mockResolvedValue([{ id: 'booking-created' }]);
    renderInspector();

    await user.click(screen.getByRole('button', { name: i18n.t('booking.increaseQuantity') }));
    await user.click(screen.getByRole('button', { name: i18n.t('booking.submit') }));

    expect(await screen.findByRole('status')).toHaveTextContent(i18n.t('booking.successTitle'));
    const releasedSubmit = await screen.findByRole('button', { name: i18n.t('booking.submit') }, { timeout: 2_000 });
    expect(releasedSubmit).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('1');

    await user.click(releasedSubmit);
    expect(apiMock.createBookings).toHaveBeenCalledTimes(2);
  });

  it('requires a reason for every third-party booking while retaining quantity', async () => {
    const user = userEvent.setup();
    apiMock.createBookings.mockResolvedValue([{ id: 'booking-created' }]);
    renderInspector();

    await user.click(screen.getByRole('button', { name: i18n.t('booking.forMember') }));
    await user.click(screen.getByRole('checkbox', { name: /Target Member/ }));

    const submit = screen.getByRole('button', { name: i18n.t('booking.submitMultiple', { count: 2 }) });
    const reasonLabel = `${i18n.t('booking.reason')} *`;
    expect(screen.getByLabelText(reasonLabel)).toBeRequired();
    expect(screen.getByText(i18n.t('booking.quantity'))).toBeVisible();
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(reasonLabel), 'Shared team purchase');
    await user.click(screen.getByRole('button', { name: i18n.t('booking.increaseQuantity') }));
    expect(screen.getByText(i18n.t('booking.total'))).toBeVisible();
    expect(screen.getByText(/2,00.*pro Mitglied/)).toBeVisible();
    await user.click(submit);

    expect(apiMock.createBookings).toHaveBeenCalledWith('group-a', {
      productId: product.id,
      productVersion: product.version,
      expectedPeriodId: period.id,
      quantity: 2,
      targetMembershipIds: ['member-actor', 'member-target'],
      reason: 'Shared team purchase',
    });
  });

  it('requires and validates an unprefilled unit price for user-defined products', async () => {
    const user = userEvent.setup();
    const customProduct: Product = {
      ...product,
      id: 'product-donation',
      name: 'Donation',
      pricingMode: 'USER_DEFINED',
      price: undefined,
    };
    apiMock.createBookings.mockResolvedValue([{ id: 'booking-created' }]);
    renderInspector(customProduct);

    const priceInput = screen.getByLabelText(i18n.t('booking.unitPrice', { currency: 'EUR' }));
    const memberLabel = screen.getByText(i18n.t('booking.forMember'), { selector: 'label' });
    const priceLabel = screen.getByText(i18n.t('booking.unitPrice', { currency: 'EUR' }), { selector: 'label' });
    const submit = screen.getByRole('button', { name: i18n.t('booking.submit') });
    expect(memberLabel.compareDocumentPosition(priceLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(priceInput).toHaveValue('');
    expect(submit).toBeDisabled();

    await user.type(priceInput, '0');
    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('errors.amountFormat'));
    await user.clear(priceInput);
    await user.type(priceInput, '2,50');
    await user.click(screen.getByRole('button', { name: i18n.t('booking.increaseQuantity') }));
    await user.click(submit);

    expect(apiMock.createBookings).toHaveBeenCalledWith('group-a', {
      productId: customProduct.id,
      productVersion: customProduct.version,
      expectedPeriodId: period.id,
      quantity: 2,
      unitPrice: { minorUnits: '250', currency: 'EUR' },
      targetMembershipIds: ['member-actor'],
      reason: undefined,
    });
  });

  it('replaces the untouched self default with a newly named temporary guest', async () => {
    const user = userEvent.setup();
    apiMock.createBookings.mockResolvedValue([{ id: 'booking-guest' }]);
    renderInspector(product, true);

    await user.click(screen.getByRole('button', { name: i18n.t('booking.forMember') }));
    await user.type(screen.getByLabelText(i18n.t('booking.addGuest')), '  Sam   Beispiel  ');
    await user.click(screen.getByRole('button', { name: i18n.t('booking.addGuestAction') }));
    await user.click(screen.getByRole('button', { name: i18n.t('booking.submit') }));

    await waitFor(() => expect(apiMock.createBookings).toHaveBeenCalledWith('group-a', {
      productId: product.id,
      productVersion: product.version,
      expectedPeriodId: period.id,
      quantity: 1,
      targetMembershipIds: [],
      temporaryGuestDisplayNames: ['Sam Beispiel'],
      reason: undefined,
    }));
  });

  it('appends a temporary guest after the member selection was changed explicitly', async () => {
    const user = userEvent.setup();
    apiMock.createBookings.mockResolvedValue([{ id: 'booking-shared' }]);
    renderInspector(product, true);

    await user.click(screen.getByRole('button', { name: i18n.t('booking.forMember') }));
    await user.click(screen.getByRole('checkbox', { name: /Target Member/ }));
    await user.type(screen.getByLabelText(i18n.t('booking.addGuest')), 'Guest Three');
    await user.click(screen.getByRole('button', { name: i18n.t('booking.addGuestAction') }));
    await user.type(screen.getByLabelText(`${i18n.t('booking.reason')} *`), 'Group purchase');
    await user.click(screen.getByRole('button', { name: i18n.t('booking.submitMultiple', { count: 3 }) }));

    await waitFor(() => expect(apiMock.createBookings).toHaveBeenCalledWith('group-a', expect.objectContaining({
      targetMembershipIds: ['member-actor', 'member-target'],
      temporaryGuestDisplayNames: ['Guest Three'],
      reason: 'Group purchase',
    })));
  });
});
