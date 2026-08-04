import { createContext } from 'react';
import type { Group, Session } from '@/api/types';

/** Values shared by authenticated group-scoped routes. */
export interface ActiveGroupContextValue {
  session: Session;
  activeGroup: Group;
  activeGroupId: string;
  setActiveGroupId: (groupId: string) => void;
}

/** Internal React context backing group selection. */
export const ActiveGroupContext = createContext<ActiveGroupContextValue | null>(null);
