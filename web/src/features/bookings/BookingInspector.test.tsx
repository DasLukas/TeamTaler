import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Membership, Period, Product } from '@/api/types';
import i18n from '@/i18n';
import { BookingInspector } from './BookingInspector';

const apiMock = vi.hoisted(() => ({ createBooking: vi.fn() }));

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

const members: Membership[] = [
  {
    id: 'member-actor',
    userId: 'user-actor',
    displayName: 'Assigning Member',
    email: 'actor@example.test',
    initials: 'AM',
    roles: ['MEMBER'],
    groupPermissions: [],
    categoryPermissions: [{ categoryId: product.categoryId, assignToOthers: true, voidBookings: false }],
    active: true,
  },
  {
    id: 'member-target',
    userId: 'user-target',
    displayName: 'Target Member',
    email: 'target@example.test',
    initials: 'TM',
    roles: ['MEMBER'],
    groupPermissions: [],
    categoryPermissions: [],
    active: true,
  },
];

function renderInspector(selectedProduct: Product = product): void {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  render(
    <BookingInspector
      currentMembershipId="member-actor"
      groupId="group-a"
      members={members}
      onCancel={vi.fn()}
      period={period}
      product={selectedProduct}
    />,
    { wrapper },
  );
}

describe('BookingInspector category-neutral booking rules', () => {
  it('releases the selected product for another booking after showing confirmation', async () => {
    const user = userEvent.setup();
    apiMock.createBooking.mockResolvedValue({ id: 'booking-created' });
    renderInspector();

    await user.click(screen.getByRole('button', { name: i18n.t('booking.increaseQuantity') }));
    await user.click(screen.getByRole('button', { name: i18n.t('booking.submit') }));

    expect(await screen.findByRole('status')).toHaveTextContent(i18n.t('booking.successTitle'));
    const releasedSubmit = await screen.findByRole('button', { name: i18n.t('booking.submit') }, { timeout: 2_000 });
    expect(releasedSubmit).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('1');

    await user.click(releasedSubmit);
    expect(apiMock.createBooking).toHaveBeenCalledTimes(2);
  });

  it('requires a reason for every third-party booking while retaining quantity', async () => {
    const user = userEvent.setup();
    apiMock.createBooking.mockResolvedValue({ id: 'booking-created' });
    renderInspector();

    await user.selectOptions(screen.getByLabelText(i18n.t('booking.forMember')), 'member-target');

    const submit = screen.getByRole('button', { name: i18n.t('booking.submit') });
    expect(screen.getByLabelText(i18n.t('booking.reason'))).toBeRequired();
    expect(screen.getByText(i18n.t('booking.quantity'))).toBeVisible();
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(i18n.t('booking.reason')), 'Shared team purchase');
    await user.click(screen.getByRole('button', { name: i18n.t('booking.increaseQuantity') }));
    await user.click(submit);

    expect(apiMock.createBooking).toHaveBeenCalledWith('group-a', {
      productId: product.id,
      productVersion: product.version,
      expectedPeriodId: period.id,
      quantity: 2,
      targetMembershipId: 'member-target',
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
    apiMock.createBooking.mockResolvedValue({ id: 'booking-created' });
    renderInspector(customProduct);

    const priceInput = screen.getByLabelText(i18n.t('booking.unitPrice', { currency: 'EUR' }));
    const submit = screen.getByRole('button', { name: i18n.t('booking.submit') });
    expect(priceInput).toHaveValue('');
    expect(submit).toBeDisabled();

    await user.type(priceInput, '0');
    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('errors.amountFormat'));
    await user.clear(priceInput);
    await user.type(priceInput, '2,50');
    await user.click(screen.getByRole('button', { name: i18n.t('booking.increaseQuantity') }));
    await user.click(submit);

    expect(apiMock.createBooking).toHaveBeenCalledWith('group-a', {
      productId: customProduct.id,
      productVersion: customProduct.version,
      expectedPeriodId: period.id,
      quantity: 2,
      unitPrice: { minorUnits: '250', currency: 'EUR' },
      targetMembershipId: undefined,
      reason: undefined,
    });
  });
});
