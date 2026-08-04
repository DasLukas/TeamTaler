import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

/** Properties accepted by the shared action button. */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'small' | 'medium' | 'large';
  leadingIcon?: ReactNode;
  fullWidth?: boolean;
}

/**
 * Renders an accessible action button with TeamTaler visual variants.
 *
 * @param props - Native button attributes plus visual and icon options.
 * @returns A styled native button.
 */
export function Button({
  children,
  className = '',
  variant = 'primary',
  size = 'medium',
  leadingIcon,
  fullWidth = false,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      className={`${styles.button} ${styles[variant]} ${styles[size]} ${fullWidth ? styles.fullWidth : ''} ${className}`}
      type={type}
      {...props}
    >
      {leadingIcon ? <span className={styles.icon}>{leadingIcon}</span> : null}
      <span>{children}</span>
    </button>
  );
}
