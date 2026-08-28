import { describe, expect, it } from 'vitest';
import type { Group, PermissionKey } from '@/api/types';
import { availableStatisticsViews, canOpenStatistics } from './groupCapabilities';

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

describe('statistics group capabilities', () => {
  it('keeps both views hidden behind the group master switch', () => {
    const disabled = group(false, ['VIEW_MEMBER_STATISTICS', 'VIEW_GROUP_STATISTICS']);

    expect(availableStatisticsViews(disabled)).toEqual([]);
    expect(canOpenStatistics(disabled)).toBe(false);
  });

  it('returns only independently granted views in stable tab order', () => {
    expect(availableStatisticsViews(group(true, ['VIEW_GROUP_STATISTICS']))).toEqual(['finance']);
    expect(availableStatisticsViews(group(true, ['VIEW_MEMBER_STATISTICS']))).toEqual(['members']);
    expect(availableStatisticsViews(group(true, ['VIEW_GROUP_STATISTICS', 'VIEW_MEMBER_STATISTICS']))).toEqual(['members', 'finance']);
  });

  it('honors the broad activity permission implication for member statistics', () => {
    expect(availableStatisticsViews(group(true, ['VIEW_ALL_BOOKING_ACTIVITY']))).toEqual(['members']);
  });
});
