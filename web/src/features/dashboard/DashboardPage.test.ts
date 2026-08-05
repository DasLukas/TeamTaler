import { describe, expect, it } from 'vitest';
import { getDashboardGreetingKey } from './greeting';

describe('getDashboardGreetingKey', () => {
  it.each([
    [0, 'night'],
    [4, 'night'],
    [5, 'morning'],
    [10, 'morning'],
    [11, 'day'],
    [17, 'day'],
    [18, 'evening'],
    [21, 'evening'],
    [22, 'night'],
    [23, 'night'],
  ] as const)('selects %s:00 as %s', (hour, expected) => {
    expect(getDashboardGreetingKey(hour)).toBe(expected);
  });
});
