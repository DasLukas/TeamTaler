import { describe, expect, it } from 'vitest';
import type { AccountSummary } from '@/api/types';
import { deriveAccountOverview } from './accountOverview';

const accounts: AccountSummary[] = [
  { membershipId: 'archived', displayName: 'Former Member', isTemporaryGuest: false, status: 'ARCHIVED', currency: 'EUR', balance: { minorUnits: '75', currency: 'EUR' } },
  { membershipId: 'credit', displayName: 'Credit Member', isTemporaryGuest: false, status: 'ACTIVE', currency: 'EUR', balance: { minorUnits: '-250', currency: 'EUR' } },
  { membershipId: 'zero-z', displayName: 'Zeta Member', isTemporaryGuest: false, status: 'ACTIVE', currency: 'EUR', balance: { minorUnits: '0', currency: 'EUR' } },
  { membershipId: 'large', displayName: 'Large Member', isTemporaryGuest: false, status: 'ACTIVE', currency: 'EUR', balance: { minorUnits: '9007199254740993', currency: 'EUR' } },
  { membershipId: 'zero-a', displayName: 'Alpha Member', isTemporaryGuest: false, status: 'ACTIVE', currency: 'EUR', balance: { minorUnits: '0', currency: 'EUR' } },
];

describe('deriveAccountOverview', () => {
  it('calculates exact receivables, credits, and signed net balance', () => {
    const overview = deriveAccountOverview(accounts, 'EUR');

    expect(overview.receivables.minorUnits).toBe('9007199254741068');
    expect(overview.credits.minorUnits).toBe('250');
    expect(overview.net.minorUnits).toBe('9007199254740818');
  });

  it('separates status groups and sorts by descending balance then name', () => {
    const overview = deriveAccountOverview(accounts, 'EUR');

    expect(overview.active.map((account) => account.membershipId)).toEqual(['large', 'zero-a', 'zero-z', 'credit']);
    expect(overview.archived.map((account) => account.membershipId)).toEqual(['archived']);
  });
});
