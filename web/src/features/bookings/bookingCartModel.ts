import { multiplyMoney, validatePositiveMajorUnits } from '@/api/money';
import type { Money, Product } from '@/api/types';

/** One editable product line in the booking cart. */
export interface BookingCartLine {
  product: Product;
  quantity: number;
  unitPriceInput: string;
  unitPriceTouched: boolean;
}

/**
 * Resolves the current validated price for a booking-cart line.
 *
 * @param line - Fixed-price or user-defined cart line.
 * @returns The line's price, or `undefined` while a custom price is invalid.
 */
export function resolveCartLinePrice(line: BookingCartLine): Money | undefined {
  if (line.product.pricingMode === 'FIXED') return line.product.price;
  const validation = validatePositiveMajorUnits(line.unitPriceInput, line.product.currency);
  return validation.minorUnits ? { minorUnits: validation.minorUnits, currency: line.product.currency } : undefined;
}

/**
 * Calculates the combined cart total for all selected recipients.
 *
 * @param lines - Product lines with quantities and resolved prices.
 * @param targetCount - Number of members and pending guests receiving every line.
 * @returns The exact total, or `undefined` when a custom price is incomplete.
 * @throws RangeError when lines contain mixed currencies.
 */
export function calculateCartTotal(lines: readonly BookingCartLine[], targetCount: number): Money | undefined {
  if (lines.length === 0) return undefined;
  const currency = lines[0].product.currency;
  let minorUnits = 0n;
  for (const line of lines) {
    const price = resolveCartLinePrice(line);
    if (!price) return undefined;
    if (price.currency !== currency) throw new RangeError('Booking cart lines must use the same currency.');
    minorUnits += BigInt(multiplyMoney(price, line.quantity).minorUnits);
  }
  return { minorUnits: (minorUnits * BigInt(targetCount)).toString(), currency };
}
