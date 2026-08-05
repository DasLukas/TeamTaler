import type { GroupRole } from '@/api/types';

/** Group-level workspaces that are protected by cumulative membership roles. */
export type GroupCapability = 'administration' | 'catalog' | 'finance';

/**
 * Determines whether cumulative group roles grant access to a workspace.
 *
 * Administrators inherit every capability. Dedicated managers receive only
 * their respective catalog or finance capability.
 *
 * @param roles - Roles assigned to the active group membership.
 * @param capability - Workspace capability to evaluate.
 * @returns Whether the membership may open the requested workspace.
 */
export function hasGroupCapability(roles: readonly GroupRole[], capability: GroupCapability): boolean {
  if (roles.includes('ADMIN')) return true;
  if (capability === 'catalog') return roles.includes('CATALOG_MANAGER');
  if (capability === 'finance') return roles.includes('FINANCE_MANAGER');
  return false;
}
