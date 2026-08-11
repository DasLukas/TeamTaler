import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { currencyExponent, formatMoney, isCreditBalance, majorUnitsInputPattern, majorUnitsInputValue, minorUnitsToSafeNumber, multiplyMoney, normalizeMoney, parseMajorUnits, parsePositiveMajorUnits, validatePositiveMajorUnits } from './money';

describe('money utilities', () => {
  it('normalizes primitive major-unit values', () => {
    expect(normalizeMoney('23.40')).toEqual({ minorUnits: '2340', currency: 'EUR' });
    expect(normalizeMoney(1.5)).toEqual({ minorUnits: '150', currency: 'EUR' });
  });

  it.each([['1,05', '105'], ['0.10', '10'], ['23', '2300']])('parses %s without floating-point arithmetic', (input, expected) => {
    expect(parseMajorUnits(input)).toBe(expected);
  });

  it('parses and formats currencies with zero, two, and three fraction digits', () => {
    expect(currencyExponent('JPY')).toBe(0);
    expect(parseMajorUnits('123', 'JPY')).toBe('123');
    expect(() => parseMajorUnits('123,4', 'JPY')).toThrow(TypeError);
    expect(formatMoney({ minorUnits: '123', currency: 'JPY' })).toContain('123');

    expect(currencyExponent('EUR')).toBe(2);
    expect(parseMajorUnits('1,23', 'EUR')).toBe('123');
    expect(formatMoney({ minorUnits: '123', currency: 'EUR' })).toContain('1,23');

    expect(currencyExponent('KWD')).toBe(3);
    expect(parseMajorUnits('1,234', 'KWD')).toBe('1234');
    expect(formatMoney({ minorUnits: '1234', currency: 'KWD' })).toContain('1,234');
    expect(majorUnitsInputPattern('KWD')).toContain('{1,3}');
  });

  it('renders exact editable values without floating-point conversion', () => {
    expect(majorUnitsInputValue({ minorUnits: '123', currency: 'JPY' })).toBe('123');
    expect(majorUnitsInputValue({ minorUnits: '105', currency: 'EUR' })).toBe('1,05');
    expect(majorUnitsInputValue({ minorUnits: '1234', currency: 'KWD' })).toBe('1,234');
  });

  it.each(['1.005', '-1.00', 'abc', ''])('rejects invalid major units %s', (input) => {
    expect(() => parseMajorUnits(input)).toThrow(TypeError);
  });

  it('validates positive bounded product prices without throwing during form rendering', () => {
    expect(parsePositiveMajorUnits('1,25', 'EUR')).toBe('125');
    expect(() => parsePositiveMajorUnits('0', 'EUR')).toThrow(TypeError);
    expect(() => parsePositiveMajorUnits('1000000000,01', 'EUR')).toThrow(RangeError);
    expect(validatePositiveMajorUnits('invalid', 'EUR')).toEqual({ error: i18n.t('errors.amountFormat') });
  });

  it('normalizes snake-case backend values', () => {
    expect(normalizeMoney({ minor_units: 500, currency: 'EUR' })).toEqual({ minorUnits: '500', currency: 'EUR' });
  });

  it('multiplies and formats without floating-point arithmetic', () => {
    const total = multiplyMoney({ minorUnits: '150', currency: 'EUR' }, 3);
    expect(total).toEqual({ minorUnits: '450', currency: 'EUR' });
    expect(formatMoney(total)).toContain('4,50');
  });

  it('recognizes member credit from the open-balance ledger sign', () => {
    expect(isCreditBalance({ minorUnits: '-250', currency: 'EUR' })).toBe(true);
    expect(isCreditBalance({ minorUnits: '0', currency: 'EUR' })).toBe(false);
    expect(isCreditBalance({ minorUnits: '250', currency: 'EUR' })).toBe(false);
  });

  it('range-checks the final JSON integer boundary', () => {
    expect(minorUnitsToSafeNumber('105')).toBe(105);
    expect(() => minorUnitsToSafeNumber('9007199254740992')).toThrow(RangeError);
  });
});
