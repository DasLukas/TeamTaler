import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './IconButton.module.css';

/** Properties accepted by the icon-only action button. */
export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
  variant?: 'plain' | 'surface' | 'dark';
}

/**
 * Renders an icon-only control with a mandatory accessible label.
 *
 * @param props - Native button attributes, label, icon, and visual variant.
 * @returns An accessible styled button.
 */
export function IconButton({ label, children, className = '', variant = 'plain', type = 'button', ...props }: IconButtonProps) {
  return (
    <button aria-label={label} className={`${styles.button} ${styles[variant]} ${className}`} title={label} type={type} {...props}>
      {children}
    </button>
  );
}
