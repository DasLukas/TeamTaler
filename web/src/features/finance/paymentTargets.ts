import { majorUnitsInputValue } from '@/api/money';
import type { Money, PaymentTarget, SepaTransferPaymentTarget } from '@/api/types';

const PAYPAL_ME_HANDLE_PATTERN = /^[A-Za-z0-9]{1,20}$/;
const IBAN_PATTERN = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/;
const BIC_PATTERN = /^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const MAX_EPC_AMOUNT_MINOR = 99_999_999_999n;
const MAX_EPC_PAYLOAD_BYTES = 331;
const EEA_IBAN_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IE', 'IT',
  'LV', 'LI', 'LT', 'LU', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER_PATTERN.test(value);
}

/** Stable error reasons returned when an EPC payment payload cannot be generated. */
export type EpcQrPayloadError = 'INVALID_TARGET' | 'INVALID_AMOUNT' | 'REFERENCE_TOO_LONG' | 'PAYLOAD_TOO_LONG';

/** Result of constructing one EPC QR payload without throwing from interactive rendering. */
export type EpcQrPayloadResult =
  | { payload: string; error: null }
  | { payload: null; error: EpcQrPayloadError };

/**
 * Reports whether a value is a canonical PayPal.Me handle.
 *
 * @param value - Candidate handle without a URL prefix.
 * @returns Whether the handle contains one to twenty ASCII letters or digits.
 */
export function isPaypalMeHandle(value: string): boolean {
  return PAYPAL_ME_HANDLE_PATTERN.test(value);
}

/**
 * Extracts a canonical PayPal.Me handle from a handle or trusted PayPal URL.
 *
 * @param value - Administrator-entered handle or complete HTTPS PayPal.Me URL.
 * @returns The handle with preserved readable casing, or `null` for an unsafe value.
 */
export function normalizePaypalMeHandle(value: string): string | null {
  const trimmed = value.trim();
  if (isPaypalMeHandle(trimmed)) return trimmed;
  try {
    const candidate = /^(?:www\.)?paypal\.me\//i.test(trimmed) ? `https://${trimmed}` : trimmed;
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !['paypal.me', 'www.paypal.me'].includes(url.hostname.toLowerCase()) || url.search || url.hash) return null;
    const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    if (!path.startsWith('/') || path.slice(1).includes('/') || path.includes('%')) return null;
    const handle = path.slice(1);
    return isPaypalMeHandle(handle) ? handle : null;
  } catch {
    return null;
  }
}

/**
 * Removes presentation whitespace and uppercases an IBAN for validation and transport.
 *
 * @param value - Human-entered IBAN.
 * @returns Compact uppercase IBAN.
 */
export function normalizeIban(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

/**
 * Validates an IBAN's structure and ISO 13616 MOD-97 checksum.
 *
 * @param value - Compact or whitespace-separated IBAN.
 * @returns Whether the normalized IBAN has a valid checksum.
 */
export function isValidIban(value: string): boolean {
  const iban = normalizeIban(value);
  if (!IBAN_PATTERN.test(iban)) return false;
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  let remainder = 0;
  for (const character of rearranged) {
    const digits = character >= 'A' && character <= 'Z'
      ? String(character.charCodeAt(0) - 55)
      : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/**
 * Removes presentation whitespace and uppercases a BIC.
 *
 * @param value - Human-entered BIC.
 * @returns Compact uppercase BIC.
 */
export function normalizeBic(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

/**
 * Validates an optional ISO 9362 BIC.
 *
 * @param value - Compact or whitespace-separated BIC.
 * @returns Whether the value is empty or a valid eight- or eleven-character BIC.
 */
export function isValidBic(value: string): boolean {
  const bic = normalizeBic(value);
  return !bic || BIC_PATTERN.test(bic);
}

/**
 * Reports whether the EPC transfer requires a BIC for an IBAN country.
 *
 * @param value - Compact or whitespace-separated IBAN.
 * @returns `true` for malformed and non-EEA country prefixes, otherwise `false`.
 */
export function isBicRequiredForIban(value: string): boolean {
  const iban = normalizeIban(value);
  return iban.length < 2 || !EEA_IBAN_COUNTRIES.has(iban.slice(0, 2));
}

/**
 * Validates one external payment destination against its group currency.
 *
 * @param target - Nullable configured destination.
 * @param currency - Three-letter active-group currency.
 * @returns Whether the destination can be persisted and rendered safely.
 */
export function isPaymentTargetValid(target: PaymentTarget | null, currency: string): boolean {
  if (!target) return true;
  if (target.type === 'PAYPAL_ME') return normalizePaypalMeHandle(target.paypalMeHandle) !== null;
  const recipientName = target.recipientName.trim();
  const bic = normalizeBic(target.bic ?? '');
  return currency === 'EUR'
    && recipientName.length > 0
    && Array.from(recipientName).length <= 70
    && !hasControlCharacter(recipientName)
    && isValidIban(target.iban)
    && isValidBic(bic)
    && (!isBicRequiredForIban(target.iban) || Boolean(bic));
}

/**
 * Builds an exact PayPal.Me amount URL without floating-point conversion.
 *
 * @param handle - Canonical PayPal.Me handle.
 * @param amount - Positive amount represented in integer minor units.
 * @returns Safe HTTPS PayPal.Me URL containing amount and currency.
 * @throws TypeError when the handle or amount is malformed.
 * @throws RangeError when the currency is not a three-letter code.
 */
export function buildPaypalMePaymentUrl(handle: string, amount: Money): string {
  let minorUnits: bigint;
  try {
    minorUnits = BigInt(amount.minorUnits);
  } catch {
    throw new TypeError('A valid PayPal.Me handle and positive amount are required.');
  }
  if (!isPaypalMeHandle(handle) || minorUnits <= 0n) throw new TypeError('A valid PayPal.Me handle and positive amount are required.');
  return `https://paypal.me/${handle}/${majorUnitsInputValue(amount).replace(',', '.')}${amount.currency.toUpperCase()}`;
}

/**
 * Builds an EPC069-12 version-002 UTF-8 payload for a SEPA credit transfer.
 *
 * @param target - Valid beneficiary, IBAN, and optional BIC.
 * @param amount - Positive EUR amount represented in integer cents.
 * @param reference - Optional unstructured remittance information.
 * @returns A payload or a stable failure reason suitable for localization.
 */
export function buildEpcQrPayload(target: SepaTransferPaymentTarget, amount: Money, reference = ''): EpcQrPayloadResult {
  if (!isPaymentTargetValid(target, amount.currency)) return { payload: null, error: 'INVALID_TARGET' };
  let minorUnits: bigint;
  try {
    minorUnits = BigInt(amount.minorUnits);
  } catch {
    return { payload: null, error: 'INVALID_AMOUNT' };
  }
  if (minorUnits <= 0n || minorUnits > MAX_EPC_AMOUNT_MINOR) return { payload: null, error: 'INVALID_AMOUNT' };

  const normalizedReference = reference.trim();
  if (Array.from(normalizedReference).length > 140 || hasControlCharacter(normalizedReference)) {
    return { payload: null, error: 'REFERENCE_TOO_LONG' };
  }

  const fields = [
    'BCD',
    '002',
    '1',
    'SCT',
    normalizeBic(target.bic ?? ''),
    target.recipientName.trim(),
    normalizeIban(target.iban),
    `EUR${majorUnitsInputValue(amount).replace(',', '.')}`,
    '',
    '',
    normalizedReference,
  ];
  while (fields.at(-1) === '') fields.pop();
  const payload = fields.join('\n');
  if (new TextEncoder().encode(payload).byteLength > MAX_EPC_PAYLOAD_BYTES) return { payload: null, error: 'PAYLOAD_TOO_LONG' };
  return { payload, error: null };
}
