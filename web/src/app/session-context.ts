import { createContext } from 'react';
import type { InstanceCapabilities, Session } from '@/api/types';

/** Values shared by all authenticated routes, including accounts without a group. */
export interface SessionContextValue {
  session: Session;
  instanceCapabilities: InstanceCapabilities;
}

/** Internal context for global authenticated identity and instance capabilities. */
export const SessionContext = createContext<SessionContextValue | null>(null);
