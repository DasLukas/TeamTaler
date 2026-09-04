import { describe, expect, it } from 'vitest';
import { createMoneyChartScale, formatStatisticsMoney } from './statisticsFormat';

describe('statistics money chart scaling', () => {
  it('keeps int64 coordinates safe without flattening a small non-zero value', () => {
    const currency = 'EUR';
    const maximum = { minorUnits: '9223372036854775807', currency };
    const small = { minorUnits: '1', currency };
    const negativeSmall = { minorUnits: '-1', currency };
    const scale = createMoneyChartScale([maximum, small, negativeSmall]);

    expect(scale.divisor).toBeGreaterThan(1n);
    expect(Number.isSafeInteger(Math.trunc(scale.coordinate(maximum)))).toBe(true);
    expect(scale.coordinate(small)).toBeGreaterThan(0);
    expect(scale.coordinate(negativeSmall)).toBeLessThan(0);
    expect(formatStatisticsMoney(maximum)).toContain('92.233.720.368.547.758,07');
    expect(formatStatisticsMoney(small)).toContain('0,01');
  });

  it('keeps exact minor-unit coordinates when scaling is unnecessary', () => {
    const scale = createMoneyChartScale([{ minorUnits: '250', currency: 'EUR' }, { minorUnits: '-75', currency: 'EUR' }]);

    expect(scale.divisor).toBe(1n);
    expect(scale.coordinate({ minorUnits: '250', currency: 'EUR' })).toBe(250);
    expect(scale.coordinate({ minorUnits: '-75', currency: 'EUR' })).toBe(-75);
  });
});
