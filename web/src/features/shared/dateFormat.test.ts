import { describe, expect, it } from 'vitest';
import { formatGermanDate, formatGermanDateTime } from './dateFormat';

describe('German date formatting', () => {
  it('formats date-only values as DD.MM.YYYY without changing their calendar day', () => {
    expect(formatGermanDate('2026-09-07')).toBe('07.09.2026');
  });

  it('formats timestamps with a two-digit date and 24-hour time', () => {
    const value = new Date(2026, 8, 7, 16, 48);
    expect(formatGermanDateTime(value)).toBe('07.09.2026, 16:48');
  });
});
