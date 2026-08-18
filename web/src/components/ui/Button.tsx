import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

interface CommonButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'small' | 'medium' | 'large';
  leadingIcon: ReactNode;
  fullWidth?: boolean;
  children: ReactNode;
}

/** Properties accepted by the shared action button. */
export type ButtonProps = CommonButtonProps & (
  | { collapseLabelAt?: undefined }
  | { collapseLabelAt: 'narrow' | 'tablet'; 'aria-label': string }
);

/**
 * Renders an accessible action button with TeamTaler visual variants.
 *
 * @param props - Native button attributes plus a required semantic icon and visible label.
 * @returns A styled native button.
 */
export function Button({
  children,
  className = '',
  collapseLabelAt,
  variant = 'primary',
  size = 'medium',
  leadingIcon,
  fullWidth = false,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      className={`${styles.button} ${styles[variant]} ${styles[size]} ${fullWidth ? styles.fullWidth : ''} ${collapseLabelAt ? styles[`collapseLabelAt${collapseLabelAt === 'tablet' ? 'Tablet' : 'Narrow'}`] : ''} ${className}`}
      type={type}
      {...props}
    >
      <span aria-hidden="true" className={styles.icon}>{leadingIcon}</span>
      <span className={styles.label}>{children}</span>
    </button>
  );
}
