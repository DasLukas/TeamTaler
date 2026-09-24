import { describe, expect, it } from 'vitest';
import type { Category, Product } from '@/api/types';
import { barcodeKey, resolveKioskScan, ScanRearm } from './kioskScan';

const product: Product = { id: 'water', categoryId: 'drinks', version: 1, name: 'Water', pricingMode: 'FIXED', currency: 'EUR', active: true, sortOrder: 0, barcodes: [{ format: 'UPC_E', value: '01234565' }, { format: 'CODE_128', value: '036000291452' }] };
const categories: Category[] = [{ id: 'drinks', version: 1, name: 'Drinks', icon: 'other', active: true, sortOrder: 0, products: [product] }];

describe('kiosk scanner resolution', () => {
  it('treats UPC-E, UPC-A, and EAN-13 as the same GTIN', () => {
    expect(barcodeKey('UPC_E', '01234565')).toBe(barcodeKey('UPC_A', '012345000065'));
    expect(barcodeKey('UPC_A', '012345000065')).toBe(barcodeKey('EAN_13', '0012345000065'));
    expect(resolveKioskScan('012345000065', 'group-a', categories, 'UPC_A')).toEqual({ kind: 'product', product });
  });

  it('keeps numeric Code 128 distinct from retail GTINs', () => {
    expect(resolveKioskScan('036000291452', 'group-a', categories, 'CODE_128')).toEqual({ kind: 'product', product });
    expect(resolveKioskScan('036000291452', 'group-a', categories, 'UPC_A')).toEqual({ kind: 'unknown' });
  });

  it('requires a matching group and active product for QR links', () => {
    const link = `${window.location.origin}/book?group=group-a&product=water&scan=1`;
    expect(resolveKioskScan(link, 'group-a', categories, 'QR_CODE')).toEqual({ kind: 'product', product });
    expect(resolveKioskScan(link, 'group-b', categories, 'QR_CODE')).toEqual({ kind: 'unknown' });
    expect(resolveKioskScan(link, 'group-a', [{ ...categories[0], active: false }], 'QR_CODE')).toEqual({ kind: 'unknown' });
  });

  it('does not count the same visible code twice before it leaves view', () => {
    const rearm = new ScanRearm();
    expect(rearm.accept('A', 100)).toBe(true);
    expect(rearm.accept('A', 200)).toBe(false);
    rearm.missing(300);
    expect(rearm.accept('A', 500)).toBe(false);
    expect(rearm.accept('A', 751)).toBe(true);
    expect(rearm.accept('B', 760)).toBe(true);
  });
});
