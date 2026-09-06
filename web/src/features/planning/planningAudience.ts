import type { PlanningAudience } from '@/api/types';

/**
 * Detects whether an audience edit removes any target from a published event.
 *
 * @param original - Persisted audience of the published occurrence.
 * @param next - Audience currently selected in the form.
 * @returns `true` when the next audience is narrower than the original audience.
 */
export function planningAudienceIsReduced(original: PlanningAudience, next: PlanningAudience): boolean {
  if (original.type === 'ALL_ACTIVE_MEMBERS') return next.type !== 'ALL_ACTIVE_MEMBERS';
  if (next.type === 'ALL_ACTIVE_MEMBERS') return false;
  const nextRoles = new Set(next.roleIds);
  const nextMembers = new Set(next.memberIds);
  return original.roleIds.some((roleId) => !nextRoles.has(roleId))
    || original.memberIds.some((memberId) => !nextMembers.has(memberId));
}
