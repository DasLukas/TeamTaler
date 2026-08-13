import { fireEvent, render, screen, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '@/api/types';
import i18n from '@/i18n';
import { BookingCart, type BookingCartProps } from './BookingCart';
import type { BookingCartLine } from './bookingCartModel';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

function userDefinedCartLine(index: number): BookingCartLine {
  return {
    product: {
      ...fixedProduct(index),
      name: `Flexible Product ${index}`,
      pricingMode: 'USER_DEFINED',
      price: undefined,
    },
    quantity: 1,
    unitPriceInput: '',
    unitPriceTouched: false,
  };
}

function renderCart(overrides: Partial<BookingCartProps> = {}): RenderResult {
  return render(<BookingCart
    bookingReasons={[]}
    compact={false}
    lines={[cartLine(1)]}
    onQuantityChange={vi.fn()}
    onReasonChange={vi.fn()}
    onRemove={vi.fn()}
    onSubmit={vi.fn()}
    onUnitPriceBlur={vi.fn()}
    onUnitPriceChange={vi.fn()}
    onViewChange={vi.fn()}
    pending={false}
    reason=""
    reasonMode="OFF"
    targetCount={1}
    view="details"
    {...overrides}
  />);
}

describe('BookingCart booking expansion limits', () => {
  it('counts one booking row per distinct product and target regardless of quantity', () => {
    renderCart({ lines: [cartLine(1, 99)], targetCount: 2 });

    const accessibleScope = screen.getByText(i18n.t('booking.bookingScope', {
      products: i18n.t('booking.productCount', { count: 1 }),
      targets: i18n.t('booking.personCount', { count: 2 }),
      bookings: i18n.t('booking.bookingCount', { count: 2 }),
    }));
    const visualEquation = screen.getByText('×').parentElement;
    expect(accessibleScope).toHaveClass('sr-only');
    expect(visualEquation).toHaveTextContent('1×2=2');
    expect(visualEquation?.querySelectorAll('svg')).toHaveLength(3);
    expect(visualEquation?.previousElementSibling).toHaveTextContent('198,00');
    expect(screen.getByRole('button', { name: i18n.t('booking.submitBookings') })).toBeEnabled();
    expect(screen.getByText(/198,00/)).toBeVisible();
  });

  it('removes the recipient name and shows only the result for one target', () => {
    renderCart({ lines: [cartLine(1), cartLine(2)], targetCount: 1 });

    expect(screen.queryByText('Ada Admin')).not.toBeInTheDocument();
    expect(screen.getByText(i18n.t('booking.bookingCount', { count: 2 }))).toBeVisible();
    expect(screen.queryByText(i18n.t('booking.bookingScope', {
      products: i18n.t('booking.productCount', { count: 2 }),
      targets: i18n.t('booking.personCount', { count: 1 }),
      bookings: i18n.t('booking.bookingCount', { count: 2 }),
    }))).not.toBeInTheDocument();
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
    expect(checkout).toContainElement(screen.getByRole('button', { name: i18n.t('booking.submitBookings') }));
  });

  it('uses the production sheet handle without a separate minimize icon', () => {
    const { container } = renderCart({ compact: true, view: 'details' });

    const minimizeHandle = container.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('booking.cartMinimize')}"]`);
    expect(minimizeHandle).not.toBeNull();
    expect(container.querySelector('form > button > span[aria-hidden="true"]')).toBeInTheDocument();
    expect(minimizeHandle?.querySelector('svg')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: i18n.t('booking.cartCollapse') })).toHaveAttribute('aria-expanded', 'true');
  });

  it('minimizes the compact sheet when its handle is swiped down', () => {
    const onViewChange = vi.fn();
    const { container } = renderCart({ compact: true, onViewChange, view: 'summary' });
    const handle = container.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('booking.cartMinimize')}"]`);
    expect(handle).not.toBeNull();
    if (!handle) return;

    fireEvent.pointerDown(handle, { button: 0, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 180, pointerId: 1 });

    expect(onViewChange).toHaveBeenCalledWith('peek');
  });

  it('keeps the reason above the result and the result directly above the primary action', () => {
    renderCart({ compact: true, view: 'summary', reasonMode: 'REQUIRED', targetCount: 2 });

    const reasonInput = screen.getByLabelText(`${i18n.t('booking.reason')} *`);
    const reasonField = reasonInput.parentElement;
    const submit = screen.getByRole('button', { name: i18n.t('booking.submitBookings') });
    const scope = screen.getByText(i18n.t('booking.bookingScope', {
      products: i18n.t('booking.productCount', { count: 1 }),
      targets: i18n.t('booking.personCount', { count: 2 }),
      bookings: i18n.t('booking.bookingCount', { count: 2 }),
    })).parentElement;
    const checkout = reasonInput.closest('footer');
    expect(checkout).not.toBeNull();
    expect(reasonField?.nextElementSibling).toBe(scope);
    expect(scope?.nextElementSibling).toBe(submit);
    expect(submit).toBeDisabled();
  });

  it('keeps an optional reason out of the compact summary and inside cart details', () => {
    const { rerender } = renderCart({ compact: true, reasonMode: 'OPTIONAL', view: 'summary' });
    expect(screen.queryByLabelText(i18n.t('booking.reason'))).not.toBeInTheDocument();

    rerender(<BookingCart
      bookingReasons={[]}
      compact
      lines={[cartLine(1)]}
      onQuantityChange={vi.fn()}
      onReasonChange={vi.fn()}
      onRemove={vi.fn()}
      onSubmit={vi.fn()}
      onUnitPriceBlur={vi.fn()}
      onUnitPriceChange={vi.fn()}
      onViewChange={vi.fn()}
      pending={false}
      reason=""
      reasonMode="OPTIONAL"
      targetCount={1}
      view="details"
    />);

    const reason = screen.getByLabelText(i18n.t('booking.reason'));
    expect(reason).not.toBeRequired();
    expect(reason).toHaveAttribute('placeholder', i18n.t('booking.reason'));
  });

  it('focuses and reveals a requested price-entry line inside the compact cart', () => {
    const priceLine = userDefinedCartLine(3);
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: Element) {
      const top = this instanceof HTMLLIElement ? 460 : this instanceof HTMLDivElement ? 120 : 0;
      return { bottom: top, height: 0, left: 0, right: 0, top, width: 0, x: 0, y: top, toJSON: () => ({}) };
    });

    renderCart({
      compact: true,
      lines: [cartLine(1), cartLine(2), priceLine],
      priceEntryRequest: { productId: priceLine.product.id, requestId: 1 },
      view: 'details',
    });

    const priceInput = screen.getByLabelText(i18n.t('booking.unitPriceForProduct', {
      name: priceLine.product.name,
      currency: priceLine.product.currency,
    }));
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(priceInput).toHaveFocus();
    expect(screen.getByRole('list').parentElement).toHaveProperty('scrollTop', 340);

    rectSpy.mockRestore();
  });

  it('reduces the compact cart to an accessible peek and restores the checkout on demand', async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    renderCart({ compact: true, lines: [cartLine(1), cartLine(2)], onViewChange, reasonMode: 'REQUIRED', targetCount: 3, view: 'peek' });

    const open = screen.getByRole('button', { name: i18n.t('booking.cartExpandAccessible', {
      products: i18n.t('booking.productCount', { count: 2 }),
      total: '6,00 €',
    }) });
    expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(open).toHaveTextContent(i18n.t('booking.productCount', { count: 2 }));
    expect(open).not.toHaveTextContent('3 Personen');
    expect(screen.queryByLabelText(`${i18n.t('booking.reason')} *`)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: i18n.t('booking.submitBookings') })).not.toBeInTheDocument();

    await user.click(open);
    expect(onViewChange).toHaveBeenCalledWith('summary');
  });

  it('blocks carts that would expand beyond 500 product-target bookings', () => {
    renderCart({ lines: Array.from({ length: 6 }, (_, index) => cartLine(index)), targetCount: 100 });

    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('booking.tooManyBookings'));
    expect(screen.getByRole('button', { name: i18n.t('booking.submitBookings') })).toBeDisabled();
  });
});
