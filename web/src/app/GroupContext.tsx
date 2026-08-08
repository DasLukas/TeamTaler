import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@/api/types';
import { ActiveGroupContext } from './active-group-context';
import { preferredMemberPath } from './groupCapabilities';

/**
 * Provides active-group state while preserving the server's initial choice.
 *
 * @param props - Authenticated session and descendant route content.
 * @returns An active-group context provider.
 * @throws Error when the authenticated session contains no groups.
 */
export function GroupProvider({ session, children }: { session: Session; children: ReactNode }) {
  const navigate = useNavigate();
  const [activeGroupId, setActiveGroupId] = useState(session.activeGroupId);
  const activeGroup = session.groups.find((group) => group.id === activeGroupId) ?? session.groups[0];
  const selectActiveGroup = useCallback((groupId: string) => {
    const group = session.groups.find((candidate) => candidate.id === groupId);
    if (!group) return;
    setActiveGroupId(group.id);
    void navigate({ to: preferredMemberPath(group.membership?.effectiveGrants) });
  }, [navigate, session.groups]);
  const value = useMemo(() => ({ session, activeGroup, activeGroupId: activeGroup.id, setActiveGroupId: selectActiveGroup }), [activeGroup, selectActiveGroup, session]);
  return <ActiveGroupContext.Provider value={value}>{children}</ActiveGroupContext.Provider>;
}
