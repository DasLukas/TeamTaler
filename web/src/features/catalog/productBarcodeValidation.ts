import type { ProductBarcode } from '@/api/types';

/** Translation-ready reason why a catalog barcode cannot be saved. */
export type ProductBarcodeIssue = 'required' | 'length' | 'digits' | 'checkDigit' | 'numberSystem' | 'characters' | 'unsupported' | 'duplicate' | 'limit';

/** One validated barcode and its canonical group-wide collision key. */
export interface ProductBarcodeValidation {
  issue: ProductBarcodeIssue | null;
  key: string | null;
}

const DIGITS_ONLY = /^\d+$/;
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

/**
 * Checks the final GTIN digit using alternating weights from the right.
 *
 * @param value - Complete EAN or UPC value including its check digit.
 * @returns Whether the supplied check digit is valid.
 */
function hasValidCheckDigit(value: string): boolean {
  let sum = 0;
  let weight = 3;
  for (let index = value.length - 2; index >= 0; index -= 1) {
    sum += Number(value[index]) * weight;
    weight = 4 - weight;
  }
  return (10 - sum % 10) % 10 === Number(value[value.length - 1]);
}

/**
 * Expands a valid-length UPC-E body into the twelve UPC-A digits checked by the server.
 *
 * @param value - Eight-digit UPC-E including number system and check digit.
 * @returns Expanded UPC-A value without changing its check digit.
 */
function expandUpcE(value: string): string {
  const prefix = value.slice(0, 1);
  const digits = value.slice(1, 7);
  const last = digits[5];
  let expanded: string;
  if (last === '0' || last === '1' || last === '2') expanded = prefix + digits.slice(0, 2) + last + '0000' + digits.slice(2, 5);
  else if (last === '3') expanded = prefix + digits.slice(0, 3) + '00000' + digits.slice(3, 5);
  else if (last === '4') expanded = prefix + digits.slice(0, 4) + '00000' + digits.slice(4, 5);
  else expanded = prefix + digits.slice(0, 5) + '0000' + last;
  return expanded + value[7];
}

/**
 * Validates one product barcode against the Go catalog service rules.
 *
 * @param input - Barcode format and user-entered value.
 * @returns Localizable issue and canonical key used for duplicate detection.
 * @example `validateProductBarcode({ format: 'UPC_E', value: '01234565' }).key` equals `GTIN:00012345000065`.
 */
export function validateProductBarcode(input: ProductBarcode): ProductBarcodeValidation {
  const value = input.value.trim();
  if (!value) return { issue: 'required', key: null };

  if (input.format === 'CODE_128') {
    if (value.length > 80) return { issue: 'length', key: null };
    if (!PRINTABLE_ASCII.test(value)) return { issue: 'characters', key: null };
    return { issue: null, key: `CODE128:${value}` };
  }

  const expectedLength = { EAN_8: 8, EAN_13: 13, UPC_A: 12, UPC_E: 8 }[input.format];
  if (!expectedLength) return { issue: 'unsupported', key: null };
  if (value.length !== expectedLength) return { issue: 'length', key: null };
  if (!DIGITS_ONLY.test(value)) return { issue: 'digits', key: null };
  if (input.format === 'UPC_E' && value[0] !== '0' && value[0] !== '1') return { issue: 'numberSystem', key: null };

  const expanded = input.format === 'UPC_E' ? expandUpcE(value) : value;
  if (!hasValidCheckDigit(expanded)) return { issue: 'checkDigit', key: null };
  const gtin = input.format === 'EAN_8' ? value.padStart(14, '0') : input.format === 'EAN_13' ? `0${value}` : expanded.padStart(14, '0');
  return { issue: null, key: `GTIN:${gtin}` };
}

/**
 * Validates a product's complete barcode list, including equivalent UPC/EAN duplicates.
 *
 * @param barcodes - Ordered product barcode values.
 * @returns Per-row localizable issues; `null` means the row can be saved.
 */
export function validateProductBarcodes(barcodes: ProductBarcode[]): Array<ProductBarcodeIssue | null> {
  if (barcodes.length > 50) return barcodes.map(() => 'limit');
  const seen = new Set<string>();
  return barcodes.map((barcode) => {
    const { issue, key } = validateProductBarcode(barcode);
    if (issue || !key) return issue;
    if (seen.has(key)) return 'duplicate';
    seen.add(key);
    return null;
  });
}
