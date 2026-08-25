import { useEffect, useMemo, type ReactNode } from 'react';
import type { InstanceCapabilities, Session } from '@/api/types';
import { reconcileWebPush } from '@/features/push/webPush';
import { useApplyAuthenticatedColorMode } from './useAppearance';
import { SessionContext } from './session-context';

/** Properties accepted by the global authenticated-session provider. */
export interface SessionProviderProps {
  children: ReactNode;
  instanceCapabilities: InstanceCapabilities;
  session: Session;
}

/**
 * Provides global account and instance state independently of group selection.
 *
 * @param props - Authenticated session, public instance capabilities, and descendants.
 * @returns A stable context provider for authenticated routes.
 */
export function SessionProvider({ children, instanceCapabilities, session }: SessionProviderProps) {
  useApplyAuthenticatedColorMode(session.colorMode);
  const value = useMemo(() => ({ session, instanceCapabilities }), [instanceCapabilities, session]);

  useEffect(() => {
    void reconcileWebPush(instanceCapabilities, session.user.id).catch(() => undefined);
  }, [instanceCapabilities, session.user.id]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
