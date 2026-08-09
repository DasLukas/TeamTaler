import type { Money } from './types';
import i18n from '@/i18n';

/** API wire formats accepted while the backend contract is being stabilized. */
export type MoneyInput = Money | string | number | { minor_units?: string | number; currency?: string };

/** Result returned by non-throwing positive money validation. */
export interface PositiveMajorUnitsValidation {
  minorUnits?: string;
  error?: string;
}

const MAX_SAFE_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER);
/** Maximum supported unit price in integer minor currency units. */
export const MAX_PRODUCT_PRICE_MINOR = 100_000_000_000n;
const MINOR_UNITS_PATTERN = /^-?\d+$/;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const exponentCache = new Map<string, number>();

/**
 * Resolves the ISO-style minor-unit exponent used by a currency.
 *
 * `Intl.NumberFormat` is authoritative for known currencies. A syntactically
 * valid three-letter code that the runtime does not know falls back to two
 * fraction digits so self-hosted installations can use private codes safely.
 *
 * @param currency - Three-letter currency code.
 * @returns The number of fraction digits used for one major unit.
 * @throws RangeError when the currency is not a three-letter code.
 * @example `currencyExponent('JPY')` returns `0` and `currencyExponent('KWD')` returns `3`.
 */
export function currencyExponent(currency: string): number {
  const normalized = currency.toUpperCase();
  if (!CURRENCY_CODE_PATTERN.test(normalized)) throw new RangeError('Currency must be a three-letter code.');
  const cached = exponentCache.get(normalized);
  if (cached !== undefined) return cached;
  let exponent = 2;
  try {
    exponent = new Intl.NumberFormat('de-DE', { style: 'currency', currency: normalized }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    exponent = 2;
  }
  exponentCache.set(normalized, exponent);
  return exponent;
}

/**
 * Builds an HTML input pattern for non-negative major units in a currency.
 *
 * @param currency - Three-letter currency code.
 * @returns A pattern accepting exactly the currency's supported fraction precision.
 */
export function majorUnitsInputPattern(currency: string): string {
  const exponent = currencyExponent(currency);
  return exponent === 0 ? '[0-9]+' : `[0-9]+([,.][0-9]{1,${exponent}})?`;
}

/**
 * Builds a locale-friendly example amount for a currency input.
 *
 * @param currency - Three-letter currency code.
 * @returns A whole-number example with the currency's fraction digits.
 */
export function majorUnitsPlaceholder(currency: string): string {
  const exponent = currencyExponent(currency);
  return exponent === 0 ? '2' : `2,${'0'.repeat(exponent)}`;
}

/**
 * Converts canonical minor units into an exact locale-friendly form value.
 *
 * @param money - Canonical money value to place in an editable input.
 * @returns A decimal major-unit string using a comma separator.
 * @throws TypeError when minor units are not an integer string.
 * @throws RangeError when the currency is invalid.
 * @example `majorUnitsInputValue({ minorUnits: '105', currency: 'EUR' })` returns `'1,05'`.
 */
export function majorUnitsInputValue(money: Money): string {
  if (!MINOR_UNITS_PATTERN.test(money.minorUnits)) throw new TypeError('Minor units must be an integer string.');
  const exponent = currencyExponent(money.currency);
  const factor = 10n ** BigInt(exponent);
  const raw = BigInt(money.minorUnits);
  const sign = raw < 0n ? '-' : '';
  const absolute = raw < 0n ? -raw : raw;
  const whole = absolute / factor;
  if (exponent === 0) return `${sign}${whole}`;
  const fraction = (absolute % factor).toString().padStart(exponent, '0');
  return `${sign}${whole},${fraction}`;
}

/**
 * Parses a non-negative decimal major-unit string without floating-point math.
 *
 * @param value - User-entered decimal using a comma or period separator.
 * @param currency - Currency that determines the permitted fraction precision.
 * @returns Integer minor units encoded as a decimal string.
 * @throws TypeError when the value is not a positive decimal with the currency-specific fraction precision.
 * @example `parseMajorUnits('1,05', 'EUR')` returns `'105'`; `parseMajorUnits('1,234', 'KWD')` returns `'1234'`.
 */
export function parseMajorUnits(value: string, currency = 'EUR'): string {
  const normalized = value.trim();
  const exponent = currencyExponent(currency);
  const majorUnitsPattern = exponent === 0 ? /^\+?\d+$/ : new RegExp(`^\\+?\\d+(?:[.,]\\d{1,${exponent}})?$`);
  if (!majorUnitsPattern.test(normalized)) throw new TypeError(i18n.t('errors.amountFormat'));
  const [whole, fraction = ''] = normalized.replace(/^\+/, '').replace(',', '.').split('.');
  const factor = 10n ** BigInt(exponent);
  const fractionValue = exponent === 0 ? 0n : BigInt(fraction.padEnd(exponent, '0'));
  return (BigInt(whole) * factor + fractionValue).toString();
}

/**
 * Parses and bounds a positive product price without floating-point math.
 *
 * @param value - User-entered decimal using a comma or period separator.
 * @param currency - Currency that determines the permitted fraction precision.
 * @returns Positive integer minor units encoded as a decimal string.
 * @throws TypeError when the value is empty, malformed, or zero.
 * @throws RangeError when the value exceeds the supported product-price range.
 * @example `parsePositiveMajorUnits('1,50', 'EUR')` returns `'150'`.
 */
export function parsePositiveMajorUnits(value: string, currency = 'EUR'): string {
  const minorUnits = parseMajorUnits(value, currency);
  const amount = BigInt(minorUnits);
  if (amount <= 0n) throw new TypeError(i18n.t('errors.amountFormat'));
  if (amount > MAX_PRODUCT_PRICE_MINOR) throw new RangeError(i18n.t('errors.amountRange'));
  return minorUnits;
}

/**
 * Validates a positive product price for interactive form rendering.
 *
 * @param value - User-entered localized major-unit value.
 * @param currency - Currency that determines fraction precision.
 * @returns Parsed minor units or a localized error without throwing.
 * @example `validatePositiveMajorUnits('0', 'EUR')` returns an error result.
 */
export function validatePositiveMajorUnits(value: string, currency = 'EUR'): PositiveMajorUnitsValidation {
  try {
    return { minorUnits: parsePositiveMajorUnits(value, currency) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Converts minor units to a JSON-safe integer for the current Go API.
 *
 * @param minorUnits - Integer minor units encoded as a decimal string.
 * @returns A safe JavaScript integer.
 * @throws TypeError when the input is not an integer string.
 * @throws RangeError when the amount cannot be represented exactly in JSON.
 */
export function minorUnitsToSafeNumber(minorUnits: string): number {
  if (!MINOR_UNITS_PATTERN.test(minorUnits)) throw new TypeError('Minor units must be an integer string.');
  const value = BigInt(minorUnits);
  if (value > MAX_SAFE_MINOR_UNITS || value < -MAX_SAFE_MINOR_UNITS) throw new RangeError(i18n.t('errors.amountRange'));
  return Number(value);
}

/**
 * Normalizes tolerant API money values into the frontend's canonical shape.
 *
 * @param input - Money object, major-unit string/number, or snake-case wire value.
 * @param fallbackCurrency - Currency to apply when the wire value omits one.
 * @returns A money object with integer minor units encoded as a string.
 * @throws TypeError when the input is not a valid integer or major-unit value.
 * @throws RangeError when the fallback currency is not a three-letter code.
 */
export function normalizeMoney(input: MoneyInput, fallbackCurrency = 'EUR'): Money {
  if (typeof input === 'number' || typeof input === 'string') {
    return {
      minorUnits: parseMajorUnits(String(input), fallbackCurrency),
      currency: fallbackCurrency,
    };
  }

  if ('minorUnits' in input) {
    if (!MINOR_UNITS_PATTERN.test(String(input.minorUnits))) throw new TypeError('Minor units must be an integer string.');
    return {
      minorUnits: String(input.minorUnits),
      currency: input.currency || fallbackCurrency,
    };
  }

  return {
    minorUnits: String(input.minor_units ?? '0'),
    currency: input.currency || fallbackCurrency,
  };
}

/**
 * Formats money for the German user interface.
 *
 * @param money - Canonical money value.
 * @param options - Optional Intl number-format overrides.
 * @returns A localized currency string.
 * @throws TypeError when minor units are not an integer string.
 * @throws RangeError when the currency is not a three-letter code.
 */
export function formatMoney(money: Money, options?: Intl.NumberFormatOptions): string {
  if (!MINOR_UNITS_PATTERN.test(money.minorUnits)) throw new TypeError('Minor units must be an integer string.');
  const exponent = currencyExponent(money.currency);
  const factor = 10n ** BigInt(exponent);
  const raw = BigInt(money.minorUnits);
  const absolute = raw < 0n ? -raw : raw;
  const whole = absolute / factor;
  const fraction = exponent === 0 ? '' : (absolute % factor).toString().padStart(exponent, '0');
  const formatter = new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: money.currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
    ...options,
  });
  const formatted = formatter.formatToParts(whole).map((part) => part.type === 'fraction' ? fraction : part.value).join('');
  return raw < 0n ? `-${formatted}` : formatted;
}

/**
 * Reports whether an open balance represents credit available to the member.
 *
 * Open balances use the ledger convention: positive values are owed by the
 * member, while negative values are credit in the member's favor.
 *
 * @param money - Canonical open-balance value.
 * @returns `true` when the balance is credit in the member's favor.
 * @throws SyntaxError when minor units are not a valid integer string.
 * @example `isCreditBalance({ minorUnits: '-250', currency: 'EUR' })` returns `true`.
 */
export function isCreditBalance(money: Money): boolean {
  return BigInt(money.minorUnits) < 0n;
}

/**
 * Multiplies a monetary amount by an integer quantity.
 *
 * @param money - Unit amount.
 * @param quantity - Integer multiplier.
 * @returns The multiplied amount in the same currency.
 * @throws RangeError when quantity is negative or not an integer.
 * @throws TypeError when minor units are not an integer string.
 */
export function multiplyMoney(money: Money, quantity: number): Money {
  if (!Number.isInteger(quantity) || quantity < 0) throw new RangeError('Quantity must be a non-negative integer.');
  if (!MINOR_UNITS_PATTERN.test(money.minorUnits)) throw new TypeError('Minor units must be an integer string.');
  return { minorUnits: (BigInt(money.minorUnits) * BigInt(quantity)).toString(), currency: money.currency };
}
