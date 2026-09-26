import CircleUserRound from 'lucide-react/dist/esm/icons/circle-user-round';
import type { LucideProps } from 'lucide-react';
import { ManagedImage } from '@/components/ui/ManagedImage';
import styles from './AccountNavigationIcon.module.css';

/** Account icon presentation and the current session's optional profile image. */
export interface AccountNavigationIconProps extends LucideProps {
  avatarUrl?: string;
}

/**
 * Shows a circular profile image over the existing account fallback icon.
 * @param props - Profile image URL and standard icon size and stroke properties.
 * @returns A decorative avatar, retaining the account icon while loading or on failure.
 */
export function AccountNavigationIcon({ avatarUrl, size = 23, ...props }: AccountNavigationIconProps) {
  return <span aria-hidden="true" className={styles.frame} style={{ width: size, height: size }}>
    <CircleUserRound size={size} {...props} />
    {avatarUrl ? <ManagedImage alt="" src={avatarUrl} sizes={`${size}px`} /> : null}
  </span>;
}
