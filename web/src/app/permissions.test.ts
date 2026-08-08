import { describe, expect, it } from 'vitest';
import type { PermissionGrant } from '@/api/types';
import { can, canAny, effectivePermissionKeys } from './permissions';

const grants = (...permissions: PermissionGrant['permission'][]): PermissionGrant[] => permissions.map((permission) => ({
  permission,
  scope: { type: 'GROUP' },
}));

describe('permission evaluation', () => {
  it('evaluates the union of direct role grants without depending on role names', () => {
    const effective = effectivePermissionKeys(grants('FINANCE_MANAGEMENT', 'CATALOG_MANAGEMENT'));

    expect([...effective]).toEqual(expect.arrayContaining(['FINANCE_MANAGEMENT', 'CATALOG_MANAGEMENT']));
    expect(can(grants('FINANCE_MANAGEMENT'), 'FINANCE_MANAGEMENT')).toBe(true);
    expect(can(undefined, 'FINANCE_MANAGEMENT')).toBe(false);
  });

  it('calculates broad-booking implications without persisting duplicate grants', () => {
    const direct = grants('VOID_ANY_BOOKING');
    const effective = effectivePermissionKeys(direct);

    expect(direct).toHaveLength(1);
    expect(effective).toEqual(new Set([
      'VOID_ANY_BOOKING',
      'VOID_OWN_BOOKING',
      'VIEW_ALL_BOOKING_ACTIVITY',
    ]));
    expect(can(direct, 'VOID_OWN_BOOKING')).toBe(true);
    expect(canAny(direct, ['FINANCE_MANAGEMENT', 'VIEW_ALL_BOOKING_ACTIVITY'])).toBe(true);
  });

  it('does not infer unrelated permissions', () => {
    const direct = grants('ROLE_MANAGEMENT');

    expect(can(direct, 'GROUP_ADMINISTRATION')).toBe(false);
    expect(can(direct, 'BOOK_FOR_OTHERS')).toBe(false);
    expect(canAny(direct, ['FINANCE_MANAGEMENT', 'CATALOG_MANAGEMENT'])).toBe(false);
  });
});
