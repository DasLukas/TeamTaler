import { describe, expect, it } from 'vitest';
import i18n from './i18n';
import { de } from './locales/de';

describe('German localization resources', () => {
  it.each([
    ['catalog.productCount', de.catalog.productCount_one, de.catalog.productCount_other],
    ['finance.transactionCount', de.finance.transactionCount_one, de.finance.transactionCount_other],
    ['members.activeCount', de.members.activeCount_one, de.members.activeCount_other],
    ['reports.bookingCount', de.reports.bookingCount_one, de.reports.bookingCount_other],
  ])('pluralizes %s', (key, singular, plural) => {
    expect(i18n.t(key, { count: 1 })).toBe(singular.replace('{{count}}', '1'));
    expect(i18n.t(key, { count: 2 })).toBe(plural.replace('{{count}}', '2'));
  });
});
