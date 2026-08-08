import type { PermissionGrant, PermissionKey } from '@/api/types';

/** Permissions implied by a broader group-wide permission. */
export const PERMISSION_IMPLICATIONS: Readonly<Partial<Record<PermissionKey, readonly PermissionKey[]>>> = {
  VOID_ANY_BOOKING: ['VOID_OWN_BOOKING', 'VIEW_ALL_BOOKING_ACTIVITY'],
};

/** Group resource context accepted by the first RBAC release. */
export interface GroupPermissionContext {
  type: 'GROUP';
}

const GROUP_CONTEXT: GroupPermissionContext = { type: 'GROUP' };

/**
 * Expands stored grants with all permissions implied by them.
 *
 * @param grants - Effective allow grants returned for the active membership.
 * @returns A set containing direct and transitively implied permission keys.
 *
 * @example
 * ```ts
 * effectivePermissionKeys([{ permission: 'VOID_ANY_BOOKING', scope: { type: 'GROUP' } }]);
 * // Set('VOID_ANY_BOOKING', 'VOID_OWN_BOOKING', 'VIEW_ALL_BOOKING_ACTIVITY')
 * ```
 */
export function effectivePermissionKeys(grants: readonly PermissionGrant[] = []): ReadonlySet<PermissionKey> {
  const permissions = new Set<PermissionKey>();
  const pending = grants.filter((grant) => grant.scope.type === 'GROUP').map((grant) => grant.permission);
  while (pending.length > 0) {
    const permission = pending.pop();
    if (!permission || permissions.has(permission)) continue;
    permissions.add(permission);
    pending.push(...(PERMISSION_IMPLICATIONS[permission] ?? []));
  }
  return permissions;
}

/**
 * Evaluates a permission using effective grants only.
 *
 * Role names and legacy role enums are deliberately not accepted here. This
 * keeps authorization stable when administrators rename or compose roles.
 *
 * @param grants - Effective grants for the active group membership.
 * @param permission - Stable permission key required by the caller.
 * @param context - Resource context; only group scope is enabled in this release.
 * @returns Whether a direct or implied allow grant matches the context.
 */
export function can(
  grants: readonly PermissionGrant[] | undefined,
  permission: PermissionKey,
  context: GroupPermissionContext = GROUP_CONTEXT,
): boolean {
  if (context.type !== 'GROUP') return false;
  return effectivePermissionKeys(grants).has(permission);
}

/**
 * Checks whether at least one requested permission is effective.
 *
 * @param grants - Effective grants for the active group membership.
 * @param permissions - Stable permission keys accepted by the destination.
 * @returns Whether any requested permission is granted.
 */
export function canAny(grants: readonly PermissionGrant[] | undefined, permissions: readonly PermissionKey[]): boolean {
  const effective = effectivePermissionKeys(grants);
  return permissions.some((permission) => effective.has(permission));
}

