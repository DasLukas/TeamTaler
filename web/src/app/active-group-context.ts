import { createContext } from 'react';
import type { Group, Session } from '@/api/types';

/** Optional behavior for an explicit active-group selection. */
export interface ActiveGroupSelectionOptions {
  preserveRoute?: boolean;
}

/** Values shared by authenticated group-scoped routes. */
export interface ActiveGroupContextValue {
  session: Session;
  activeGroup: Group;
  activeGroupId: string;
  setActiveGroupId: (groupId: string, options?: ActiveGroupSelectionOptions) => void;
}

/** Internal React context backing group selection. */
export const ActiveGroupContext = createContext<ActiveGroupContextValue | null>(null);
