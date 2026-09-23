import i18n from '@/i18n';
import { currencyExponent, parseMajorUnits } from '@/api/money';

/** Maximum absolute value accepted by the external-account ledger contract. */
export const MAX_EXTERNAL_ACCOUNT_AMOUNT_MINOR = 100_000_000_000_000n;

/** Result of non-throwing external-account amount validation. */
export interface ExternalAccountAmountValidation {
  minorUnits?: string;
  error?: string;
}

function requireBoundedNonZeroAmount(minorUnits: string): string {
  const amount = BigInt(minorUnits);
  const absolute = amount < 0n ? -amount : amount;
  if (amount === 0n) throw new TypeError(i18n.t('errors.amountFormat'));
  if (absolute > MAX_EXTERNAL_ACCOUNT_AMOUNT_MINOR) throw new RangeError(i18n.t('errors.amountRange'));
  return minorUnits;
}

/**
 * Parses an optional signed localized opening balance without floating-point conversion.
 *
 * @param value - Localized major-unit input, optionally prefixed with a sign.
 * @param currency - Currency defining the permitted fractional precision.
 * @returns Canonical signed minor units, or undefined for an empty optional input.
 * @throws TypeError when the input is malformed or zero.
 * @throws RangeError when its absolute value exceeds the ledger contract limit.
 * @example `parseOptionalSignedAmount('-1,50', 'EUR')` returns `'-150'`.
 */
export function parseOptionalSignedAmount(value: string, currency: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  const negative = normalized.startsWith('-');
  const unsigned = normalized.replace(/^[+-]/, '');
  const minorUnits = parseMajorUnits(unsigned, currency);
  return requireBoundedNonZeroAmount(negative ? `-${minorUnits}` : minorUnits);
}

/**
 * Parses one positive manual-flow command using the ledger-specific bound.
 *
 * @param value - Localized positive major-unit input.
 * @param currency - Currency defining the permitted fractional precision.
 * @returns Canonical positive minor units.
 * @throws TypeError when the input is malformed, zero, or negative.
 * @throws RangeError when the value exceeds the ledger contract limit.
 * @example `parseExternalAccountPositiveAmount('1,50', 'EUR')` returns `'150'`.
 */
export function parseExternalAccountPositiveAmount(value: string, currency: string): string {
  const minorUnits = requireBoundedNonZeroAmount(parseMajorUnits(value, currency));
  if (BigInt(minorUnits) <= 0n) throw new TypeError(i18n.t('errors.amountFormat'));
  return minorUnits;
}

/**
 * Validates one positive manual-flow command without throwing during rendering.
 *
 * @param value - Localized positive major-unit input.
 * @param currency - Currency defining the permitted fractional precision.
 * @returns Parsed minor units or a localized validation error.
 * @example `validateExternalAccountPositiveAmount('0', 'EUR')` returns an error result.
 */
export function validateExternalAccountPositiveAmount(value: string, currency: string): ExternalAccountAmountValidation {
  try {
    return { minorUnits: parseExternalAccountPositiveAmount(value, currency) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Input pattern for an optional signed amount in the active currency. */
export function signedAmountPattern(currency: string): string {
  const exponent = currencyExponent(currency);
  return exponent === 0 ? '-?[0-9]+' : `-?[0-9]+([,.][0-9]{1,${exponent}})?`;
}
