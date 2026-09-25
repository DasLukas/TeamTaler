import { describe, expect, it } from 'vitest';
import { formatGermanDate, formatGermanDateRange, formatGermanDateTime, localDateKey } from './dateFormat';

describe('German date formatting', () => {
  it('formats date-only values as DD.MM.YYYY without changing their calendar day', () => {
    expect(formatGermanDate('2026-09-07')).toBe('07.09.2026');
  });

  it('formats timestamps with a two-digit date and 24-hour time', () => {
    const value = new Date(2026, 8, 7, 16, 48);
    expect(formatGermanDateTime(value)).toBe('07.09.2026, 16:48');
  });

  it('formats inclusive ranges with an en dash', () => {
    expect(formatGermanDateRange('2026-09-01', '2026-09-23')).toBe('01.09.2026 – 23.09.2026');
  });

  it('creates local date keys without converting midnight through UTC', () => {
    expect(localDateKey(new Date(2026, 0, 1, 0, 30))).toBe('2026-01-01');
  });
});
