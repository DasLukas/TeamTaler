import type { Group, PermissionGrant, Session } from '@/api/types';
import { can } from './permissions';
import { memberPaths } from './paths';

/** Group-level workspaces protected by effective permission grants. */
export type GroupCapability = 'administration' | 'catalog' | 'finance';

/**
 * Determines whether effective group grants allow access to a workspace.
 *
 * @param grants - Effective grants returned for the active group membership.
 * @param capability - Workspace capability to evaluate.
 * @returns Whether the membership may open the requested workspace.
 */
export function hasGroupCapability(grants: readonly PermissionGrant[] | undefined, capability: GroupCapability): boolean {
  if (capability === 'catalog') return can(grants, 'CATALOG_MANAGEMENT');
  if (capability === 'finance') return can(grants, 'FINANCE_MANAGEMENT');
  return can(grants, 'GROUP_ADMINISTRATION') || can(grants, 'MEMBER_MANAGEMENT') || can(grants, 'ROLE_MANAGEMENT');
}

/**
 * Determines whether a membership may use the own-account payment shortcut.
 *
 * @param grants - Effective grants returned for the active group membership.
 * @returns Whether the membership may post a payment for its own account.
 */
export function canRecordOwnPayment(grants: readonly PermissionGrant[] | undefined): boolean {
  return can(grants, 'RECORD_OWN_PAYMENT');
}

/** Determines whether a membership may create at least one kind of booking. */
export function canOpenBooking(grants: readonly PermissionGrant[] | undefined): boolean {
  return can(grants, 'CREATE_OWN_BOOKING') || can(grants, 'BOOK_FOR_OTHERS') || can(grants, 'BOOK_FOR_GUESTS');
}

/** Statistics views that may be exposed by one active group membership. */
export type StatisticsView = 'members' | 'finance';

/**
 * Resolves the independently authorized statistics views for one group.
 *
 * The group-level feature switch is evaluated before grants so navigation and
 * route guards cannot advertise a disabled statistics workspace.
 *
 * @param group - Active group and its server-projected membership grants.
 * @returns Ordered member and finance views available to the current membership.
 */
export function availableStatisticsViews(group: Pick<Group, 'statisticsEnabled' | 'membership'>): StatisticsView[] {
  if (!group.statisticsEnabled) return [];
  const grants = group.membership?.effectiveGrants;
  const views: StatisticsView[] = [];
  if (can(grants, 'VIEW_MEMBER_STATISTICS')) views.push('members');
  if (can(grants, 'VIEW_GROUP_STATISTICS')) views.push('finance');
  return views;
}

/** Determines whether the active group may open the statistics workspace. */
export function canOpenStatistics(group: Pick<Group, 'statisticsEnabled' | 'membership'>): boolean {
  return availableStatisticsViews(group).length > 0;
}

/**
 * Resolves the first permitted role-specific workspace for one membership.
 *
 * @param grants - Effective grants returned for the active group membership.
 * @returns Booking, finance, catalog, administration, or the overview fallback.
 */
export function preferredMemberPath(grants: readonly PermissionGrant[] | undefined): string {
  if (canOpenBooking(grants)) return memberPaths.booking;
  if (hasGroupCapability(grants, 'finance')) return memberPaths.finance;
  if (hasGroupCapability(grants, 'catalog')) return memberPaths.catalog;
  if (hasGroupCapability(grants, 'administration')) return '/admin';
  return memberPaths.overview;
}

/**
 * Resolves the first authenticated workspace without assuming group membership.
 *
 * @param session - Fresh session returned by login or an onboarding flow.
 * @returns The System workspace for a group-less system administrator, otherwise
 * the highest-priority workspace of the active membership.
 */
export function preferredAuthenticatedPath(session: Session): string {
  const group = session.groups.find((candidate) => candidate.id === session.activeGroupId) ?? session.groups[0];
  if (!group && session.systemRoles.includes('SYSTEM_ADMINISTRATOR')) return '/admin';
  return preferredMemberPath(group?.membership?.effectiveGrants);
}
