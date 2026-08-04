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
