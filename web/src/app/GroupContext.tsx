import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/api/client';
import type { Session } from '@/api/types';
import { ActiveGroupContext, type ActiveGroupSelectionOptions } from './active-group-context';
import { useApplyEffectiveGroupTheme } from './useAppearance';
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
  const initialGroupId = session.activeGroupId ?? session.groups[0]?.id;
  if (!initialGroupId) throw new Error('GroupProvider requires at least one group.');
  const [activeGroupId, setActiveGroupId] = useState(initialGroupId);
  const preferenceWrite = useRef<Promise<void>>(Promise.resolve());
  const activeGroup = session.groups.find((group) => group.id === activeGroupId) ?? session.groups[0];
  const effectiveTheme = activeGroup?.membership?.themeOverride ?? activeGroup?.defaultTheme ?? 'TEAMTALER';
  useApplyEffectiveGroupTheme(effectiveTheme);
  if (!activeGroup) throw new Error('GroupProvider requires an active group.');
  const selectActiveGroup = useCallback((groupId: string, options?: ActiveGroupSelectionOptions) => {
    const group = session.groups.find((candidate) => candidate.id === groupId);
    if (!group) return;
    setActiveGroupId(group.id);
    preferenceWrite.current = preferenceWrite.current
      .catch(() => undefined)
      .then(() => api.recordLastUsedGroup(group.id))
      .catch(() => undefined);
    if (!options?.preserveRoute) void navigate({ to: preferredMemberPath(group.membership?.effectiveGrants) });
  }, [navigate, session.groups]);
  const value = useMemo(() => ({ session, activeGroup, activeGroupId: activeGroup.id, setActiveGroupId: selectActiveGroup }), [activeGroup, selectActiveGroup, session]);
  return <ActiveGroupContext.Provider value={value}>{children}</ActiveGroupContext.Provider>;
}
