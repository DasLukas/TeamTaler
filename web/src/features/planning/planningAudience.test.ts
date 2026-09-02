import { describe, expect, it } from 'vitest';
import type { PlanningAudience } from '@/api/types';
import { planningAudienceIsReduced } from './planningAudience';

const targeted: PlanningAudience = { type: 'SELECTED_TARGETS', roleIds: ['role-a'], memberIds: ['member-a'] };

describe('planningAudienceIsReduced', () => {
  it('distinguishes published audience reductions from additive changes', () => {
    expect(planningAudienceIsReduced(targeted, { type: 'SELECTED_TARGETS', roleIds: ['role-a', 'role-b'], memberIds: ['member-a'] })).toBe(false);
    expect(planningAudienceIsReduced(targeted, { type: 'SELECTED_TARGETS', roleIds: [], memberIds: ['member-a'] })).toBe(true);
    expect(planningAudienceIsReduced(targeted, { type: 'ALL_ACTIVE_MEMBERS', roleIds: [], memberIds: [] })).toBe(false);
    expect(planningAudienceIsReduced({ type: 'ALL_ACTIVE_MEMBERS', roleIds: [], memberIds: [] }, targeted)).toBe(true);
  });
});
