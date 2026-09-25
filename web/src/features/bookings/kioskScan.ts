import type { Category, Product, ProductBarcodeFormat } from '@/api/types';
import { parseKioskBookingLink } from './kioskDeepLink';

/** Result of resolving one scanner frame against the active group catalog. */
export type ScanResolution = { kind: 'product'; product: Product } | { kind: 'group' } | { kind: 'unknown' };

/** Canonical lookup key shared by equivalent retail barcode formats. */
export function barcodeKey(format: ProductBarcodeFormat, raw: string): string | null {
  const value = raw.trim();
  if (format === 'CODE_128') return value ? `CODE128:${value}` : null;
  if (!/^\d+$/.test(value)) return null;
  if (format === 'EAN_8' && value.length === 8) return `GTIN:${'0'.repeat(6)}${value}`;
  if (format === 'EAN_13' && value.length === 13) return `GTIN:0${value}`;
  if (format === 'UPC_A' && value.length === 12) return `GTIN:00${value}`;
  if (format !== 'UPC_E' || value.length !== 8 || !/^[01]/.test(value)) return null;
  const prefix = value[0];
  const digits = value.slice(1, 7);
  const end = digits[5];
  let expanded: string;
  if ('012'.includes(end)) expanded = prefix + digits.slice(0, 2) + end + '0000' + digits.slice(2, 5);
  else if (end === '3') expanded = prefix + digits.slice(0, 3) + '00000' + digits.slice(3, 5);
  else if (end === '4') expanded = prefix + digits.slice(0, 4) + '00000' + digits.slice(4, 5);
  else expanded = prefix + digits.slice(0, 5) + '0000' + end;
  return `GTIN:00${expanded}${value[7]}`;
}

/**
 * Resolves a scanned QR or manufacturer barcode within one group.
 *
 * @param value - Raw decoder result.
 * @param groupId - Active group, never changed by a scanned payload.
 * @param categories - Permission-filtered catalog.
 * @returns A usable product, a group poster QR, or an unknown result.
 */
export function resolveKioskScan(value: string, groupId: string, categories: Category[], format?: ProductBarcodeFormat | 'QR_CODE'): ScanResolution {
  const link = format === undefined || format === 'QR_CODE' ? parseKioskBookingLink(value) : null;
  const products = categories.filter((category) => category.active).flatMap((category) => category.products.filter((product) => product.active));
  if (link) {
    if (link.groupId !== groupId) return { kind: 'unknown' };
    if (!link.productId) return { kind: 'group' };
    const product = products.find((item) => item.id === link.productId);
    return product ? { kind: 'product', product } : { kind: 'unknown' };
  }
  if (format === 'QR_CODE') return { kind: 'unknown' };
  const normalized = format ? barcodeKey(format, value) : null;
  const product = products.find((item) => item.barcodes?.some((barcode) => normalized
    ? barcodeKey(barcode.format, barcode.value) === normalized
    : barcode.value === value.trim()));
  return product ? { kind: 'product', product } : { kind: 'unknown' };
}

/** Prevents repeated camera frames from adding one visible barcode multiple times. */
export class ScanRearm {
  private lastCode = '';
  private absenceSince = 0;

  /** Records a frame without a decoded value so the previous code may rearm. */
  missing(now: number): void {
    if (this.lastCode && this.absenceSince === 0) this.absenceSince = now;
  }

  /** Accepts a new code, or the previous code after it left view briefly. */
  accept(code: string, now: number): boolean {
    if (code === this.lastCode && (this.absenceSince === 0 || now - this.absenceSince < 450)) return false;
    this.lastCode = code;
    this.absenceSince = 0;
    return true;
  }
}
