import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './FloatingNoticeRegion.module.css';

const FloatingNoticeTargetContext = createContext<HTMLElement | null | undefined>(undefined);

/** Properties accepted by the global floating-notice region. */
export interface FloatingNoticeProviderProps {
  children: ReactNode;
}

/** Properties accepted by one item in the global floating-notice stack. */
export interface FloatingNoticeProps {
  children: ReactNode;
}

/**
 * Provides one responsive bottom-center stack for global application notices.
 *
 * @param props - Application content whose notices may use the shared stack.
 * @returns The application content and its dedicated floating-notice portal target.
 */
export function FloatingNoticeProvider({ children }: FloatingNoticeProviderProps) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return (
    <FloatingNoticeTargetContext.Provider value={target}>
      {children}
      <div className={styles.region} ref={setTarget} />
    </FloatingNoticeTargetContext.Provider>
  );
}

/**
 * Renders one notice inside the nearest shared stack.
 *
 * @param props - Notice content to place in the stack.
 * @returns A portal when a provider is present, or inline content for isolated rendering.
 */
export function FloatingNotice({ children }: FloatingNoticeProps) {
  const target = useContext(FloatingNoticeTargetContext);
  if (target === undefined) return children;
  return target ? createPortal(children, target) : null;
}
