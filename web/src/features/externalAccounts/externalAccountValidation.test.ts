import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import {
  MAX_EXTERNAL_ACCOUNT_AMOUNT_MINOR,
  parseExternalAccountPositiveAmount,
  parseOptionalSignedAmount,
  validateExternalAccountPositiveAmount,
} from './externalAccountValidation';

describe('external-account amount validation', () => {
  it('accepts the ledger limit above the product-price limit', () => {
    expect(parseExternalAccountPositiveAmount('1000000000000,00', 'EUR')).toBe(MAX_EXTERNAL_ACCOUNT_AMOUNT_MINOR.toString());
    expect(validateExternalAccountPositiveAmount('1000000000000,00', 'EUR')).toEqual({ minorUnits: MAX_EXTERNAL_ACCOUNT_AMOUNT_MINOR.toString() });
  });

  it('rejects zero, negative, and over-limit manual flow commands', () => {
    expect(() => parseExternalAccountPositiveAmount('0', 'EUR')).toThrow(i18n.t('errors.amountFormat'));
    expect(() => parseExternalAccountPositiveAmount('-1', 'EUR')).toThrow(i18n.t('errors.amountFormat'));
    expect(validateExternalAccountPositiveAmount('1000000000000,01', 'EUR')).toEqual({ error: i18n.t('errors.amountRange') });
  });

  it('accepts symmetric signed non-zero opening balances at the ledger limit', () => {
    expect(parseOptionalSignedAmount('1000000000000,00', 'EUR')).toBe('100000000000000');
    expect(parseOptionalSignedAmount('-1000000000000,00', 'EUR')).toBe('-100000000000000');
    expect(parseOptionalSignedAmount('', 'EUR')).toBeUndefined();
  });

  it('rejects zero and both signs beyond the opening-balance limit', () => {
    expect(() => parseOptionalSignedAmount('0', 'EUR')).toThrow(i18n.t('errors.amountFormat'));
    expect(() => parseOptionalSignedAmount('1000000000000,01', 'EUR')).toThrow(i18n.t('errors.amountRange'));
    expect(() => parseOptionalSignedAmount('-1000000000000,01', 'EUR')).toThrow(i18n.t('errors.amountRange'));
  });
});
