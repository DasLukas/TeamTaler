import { describe, expect, it } from 'vitest';
import type { Group, PermissionKey } from '@/api/types';
import { canOpenStatistics } from './groupCapabilities';

function group(statisticsEnabled: boolean, permissions: readonly PermissionKey[]): Pick<Group, 'statisticsEnabled' | 'membership'> {
  return {
    statisticsEnabled,
    membership: {
      id: 'member-a',
      roles: ['MEMBER'],
      groupPermissions: [],
      effectiveGrants: permissions.map((permission) => ({ permission, scope: { type: 'GROUP' } })),
      themeOverride: null,
    },
  };
}

describe('statistics group capability', () => {
  it('requires the group master switch and unified statistics grant', () => {
    expect(canOpenStatistics(group(false, ['VIEW_STATISTICS']))).toBe(false);
    expect(canOpenStatistics(group(true, []))).toBe(false);
    expect(canOpenStatistics(group(true, ['VIEW_STATISTICS']))).toBe(true);
  });

  it('does not derive statistics access from broad booking activity', () => {
    expect(canOpenStatistics(group(true, ['VIEW_ALL_BOOKING_ACTIVITY']))).toBe(false);
    expect(canOpenStatistics(group(true, ['VOID_ANY_BOOKING']))).toBe(false);
  });
});
