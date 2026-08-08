import type { PermissionGrant } from '@/api/types';
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
  return can(grants, 'GROUP_ADMINISTRATION') || can(grants, 'ROLE_MANAGEMENT');
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
  return can(grants, 'CREATE_OWN_BOOKING') || can(grants, 'BOOK_FOR_OTHERS');
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
