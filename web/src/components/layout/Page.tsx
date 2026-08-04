import type { ReactNode } from 'react';
import styles from './Page.module.css';

/** Properties accepted by the shared page container. */
export interface PageProps {
  title: string;
  intro?: string;
  actions?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  className?: string;
}

/**
 * Renders a shared page heading and responsive content container.
 *
 * @param props - Heading, actions, content, width, and class configuration.
 * @returns A consistent page-level layout.
 */
export function Page({ title, intro, actions, children, wide = false, className = '' }: PageProps) {
  return (
    <div className={`${styles.page} ${wide ? styles.wide : ''} ${className}`}>
      <header className={styles.heading}>
        <div>
          <h1>{title}</h1>
          {intro ? <p>{intro}</p> : null}
        </div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}
