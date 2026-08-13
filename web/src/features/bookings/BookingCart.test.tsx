import { render, screen, type RenderResult } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Product } from '@/api/types';
import i18n from '@/i18n';
import { BookingCart, type BookingCartProps } from './BookingCart';
import type { BookingCartLine } from './bookingCartModel';

function fixedProduct(index: number): Product {
  return {
    id: `product-${index}`,
    categoryId: 'category-a',
    version: 1,
    name: `Product ${index}`,
    pricingMode: 'FIXED',
    currency: 'EUR',
    price: { minorUnits: '100', currency: 'EUR' },
    active: true,
    sortOrder: index,
  };
}

function cartLine(index: number, quantity = 1): BookingCartLine {
  return { product: fixedProduct(index), quantity, unitPriceInput: '', unitPriceTouched: false };
}

function renderCart(overrides: Partial<BookingCartProps> = {}): RenderResult {
  return render(<BookingCart
    bookingReasons={[]}
    compact={false}
    expanded
    lines={[cartLine(1)]}
    onExpandedChange={vi.fn()}
    onQuantityChange={vi.fn()}
    onReasonChange={vi.fn()}
    onRemove={vi.fn()}
    onSubmit={vi.fn()}
    onUnitPriceBlur={vi.fn()}
    onUnitPriceChange={vi.fn()}
    pending={false}
    reason=""
    reasonRequired={false}
    targetCount={1}
    targetSummary="Self"
    {...overrides}
  />);
}

describe('BookingCart booking expansion limits', () => {
  it('counts one booking row per distinct product and target regardless of quantity', () => {
    renderCart({ lines: [cartLine(1, 99)], targetCount: 2 });

    expect(screen.getByText(i18n.t('booking.bookingScope', {
      products: i18n.t('booking.productCount', { count: 1 }),
      targets: i18n.t('booking.personCount', { count: 2 }),
      bookings: i18n.t('booking.bookingCount', { count: 2 }),
    }))).toBeVisible();
    expect(screen.getByRole('button', { name: i18n.t('booking.submitBookingCount', { count: 2 }) })).toBeEnabled();
    expect(screen.getByText(/198,00/)).toBeVisible();
  });

  it('groups the result and booking action in one persistent checkout footer', () => {
    renderCart({ lines: [cartLine(1), cartLine(2)], targetCount: 2 });

    const scope = screen.getByText(i18n.t('booking.bookingScope', {
      products: i18n.t('booking.productCount', { count: 2 }),
      targets: i18n.t('booking.personCount', { count: 2 }),
      bookings: i18n.t('booking.bookingCount', { count: 4 }),
    }));
    const checkout = scope.closest('footer');
    expect(checkout).not.toBeNull();
    expect(checkout).toContainElement(screen.getByRole('button', { name: i18n.t('booking.submitBookingCount', { count: 4 }) }));
  });

  it('uses the production sheet handle and close action for the expanded mobile cart', () => {
    const { container } = renderCart({ compact: true, expanded: true });

    expect(container.querySelector('form > span[aria-hidden="true"]')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: i18n.t('booking.cartCollapse') })).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps a mandatory reason directly above the primary action in the persistent checkout', () => {
    renderCart({ compact: true, expanded: false, reasonRequired: true, targetCount: 2 });

    const reasonInput = screen.getByLabelText(`${i18n.t('booking.reason')} *`);
    const reasonField = reasonInput.parentElement;
    const submit = screen.getByRole('button', { name: i18n.t('booking.submitBookingCount', { count: 2 }) });
    const checkout = reasonInput.closest('footer');
    expect(checkout).not.toBeNull();
    expect(reasonField?.nextElementSibling).toBe(submit);
    expect(submit).toBeDisabled();
  });

  it('blocks carts that would expand beyond 500 product-target bookings', () => {
    renderCart({ lines: Array.from({ length: 6 }, (_, index) => cartLine(index)), targetCount: 100 });

    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('booking.tooManyBookings'));
    expect(screen.getByRole('button', { name: i18n.t('booking.submitBookingCount', { count: 600 }) })).toBeDisabled();
  });
});
