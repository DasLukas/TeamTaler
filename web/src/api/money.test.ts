import { describe, expect, it } from 'vitest';
import { currencyExponent, formatMoney, majorUnitsInputPattern, minorUnitsToSafeNumber, multiplyMoney, normalizeMoney, parseMajorUnits } from './money';

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

  it.each(['1.005', '-1.00', 'abc', ''])('rejects invalid major units %s', (input) => {
    expect(() => parseMajorUnits(input)).toThrow(TypeError);
  });

  it('normalizes snake-case backend values', () => {
    expect(normalizeMoney({ minor_units: 500, currency: 'EUR' })).toEqual({ minorUnits: '500', currency: 'EUR' });
  });

  it('multiplies and formats without floating-point arithmetic', () => {
    const total = multiplyMoney({ minorUnits: '150', currency: 'EUR' }, 3);
    expect(total).toEqual({ minorUnits: '450', currency: 'EUR' });
    expect(formatMoney(total)).toContain('4,50');
  });

  it('range-checks the final JSON integer boundary', () => {
    expect(minorUnitsToSafeNumber('105')).toBe(105);
    expect(() => minorUnitsToSafeNumber('9007199254740992')).toThrow(RangeError);
  });
});
