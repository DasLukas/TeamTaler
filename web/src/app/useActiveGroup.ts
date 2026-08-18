import { useContext } from 'react';
import { ActiveGroupContext, type ActiveGroupContextValue } from './active-group-context';

/**
 * Returns the active user session and group selection.
 *
 * @returns Current authenticated group context.
 * @throws Error when called outside `GroupProvider`.
 */
export function useActiveGroup(): ActiveGroupContextValue {
  const value = useContext(ActiveGroupContext);
  if (!value) throw new Error('useActiveGroup must be used inside GroupProvider.');
  return value;
}

/**
 * Returns group selection when the current authenticated account belongs to a group.
 *
 * @returns The active-group context or `null` for a group-less system administrator.
 */
export function useOptionalActiveGroup(): ActiveGroupContextValue | null {
  return useContext(ActiveGroupContext);
}
