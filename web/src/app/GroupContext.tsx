import { useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@/api/types';
import { ActiveGroupContext } from './active-group-context';

/**
 * Provides active-group state while preserving the server's initial choice.
 *
 * @param props - Authenticated session and descendant route content.
 * @returns An active-group context provider.
 * @throws Error when the authenticated session contains no groups.
 */
export function GroupProvider({ session, children }: { session: Session; children: ReactNode }) {
  const [activeGroupId, setActiveGroupId] = useState(session.activeGroupId);
  const activeGroup = session.groups.find((group) => group.id === activeGroupId) ?? session.groups[0];
  const value = useMemo(() => ({ session, activeGroup, activeGroupId: activeGroup.id, setActiveGroupId }), [activeGroup, session]);
  return <ActiveGroupContext.Provider value={value}>{children}</ActiveGroupContext.Provider>;
}
