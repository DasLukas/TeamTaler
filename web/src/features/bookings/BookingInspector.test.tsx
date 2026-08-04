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
    categoryPermissions: [],
    active: true,
  },
];

function renderInspector(): void {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  render(
    <BookingInspector
      currentMembershipId="member-actor"
      groupId="group-a"
      members={members}
      onCancel={vi.fn()}
      period={period}
      product={product}
    />,
    { wrapper },
  );
}

describe('BookingInspector category-neutral booking rules', () => {
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
});
