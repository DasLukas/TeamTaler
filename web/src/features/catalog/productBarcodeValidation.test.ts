import { describe, expect, it } from 'vitest';
import type { ProductBarcode } from '@/api/types';
import { validateProductBarcode, validateProductBarcodes } from './productBarcodeValidation';

describe('product barcode validation', () => {
  it.each([
    [{ format: 'EAN_8', value: '96385074' }, 'GTIN:00000096385074'],
    [{ format: 'EAN_13', value: '4006381333931' }, 'GTIN:04006381333931'],
    [{ format: 'UPC_A', value: '012345000065' }, 'GTIN:00012345000065'],
    [{ format: 'UPC_E', value: '01234565' }, 'GTIN:00012345000065'],
    [{ format: 'CODE_128', value: 'ABC-123' }, 'CODE128:ABC-123'],
  ] as const)('accepts %j and returns its canonical key', (barcode, key) => {
    expect(validateProductBarcode(barcode)).toEqual({ issue: null, key });
  });

  it.each([
    [{ format: 'EAN_13', value: '400638133393' }, 'length'],
    [{ format: 'EAN_13', value: '4006381333932' }, 'checkDigit'],
    [{ format: 'EAN_8', value: '9638507X' }, 'digits'],
    [{ format: 'UPC_E', value: '21234565' }, 'numberSystem'],
    [{ format: 'UPC_E', value: '01234566' }, 'checkDigit'],
    [{ format: 'CODE_128', value: 'AB\nC' }, 'characters'],
    [{ format: 'CODE_128', value: 'A'.repeat(81) }, 'length'],
    [{ format: 'UPC_A', value: ' ' }, 'required'],
    [{ format: 'QR' as ProductBarcode['format'], value: '12345678' }, 'unsupported'],
  ] as const)('rejects %j with %s', (barcode, issue) => {
    expect(validateProductBarcode(barcode).issue).toBe(issue);
  });

  it('recognizes equivalent UPC-A, EAN-13, and UPC-E values as duplicates', () => {
    expect(validateProductBarcodes([
      { format: 'UPC_A', value: '012345000065' },
      { format: 'EAN_13', value: '0012345000065' },
      { format: 'UPC_E', value: '01234565' },
    ])).toEqual([null, 'duplicate', 'duplicate']);
  });

  it('caps the list at the same fifty entries as the server', () => {
    expect(validateProductBarcodes(Array.from({ length: 51 }, (_, index) => ({ format: 'CODE_128', value: `item-${index}` })))).toEqual(Array(51).fill('limit'));
  });
});
