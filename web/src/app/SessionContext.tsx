import { useMemo, type ReactNode } from 'react';
import type { InstanceCapabilities, Session } from '@/api/types';
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
  const value = useMemo(() => ({ session, instanceCapabilities }), [instanceCapabilities, session]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
