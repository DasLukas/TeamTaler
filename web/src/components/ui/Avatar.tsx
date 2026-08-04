import styles from './Avatar.module.css';

/** Properties accepted by the avatar component. */
export interface AvatarProps {
  /** Hides the avatar from assistive technology when adjacent text already names the person. */
  decorative?: boolean;
  name: string;
  src?: string;
  size?: 'small' | 'medium' | 'large';
  className?: string;
}

/** Returns up to two initials for an avatar fallback. */
function initialsForName(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('');
}

/**
 * Renders a user avatar with an image-independent initials fallback.
 *
 * @param props - Display name, optional image, size, and class configuration.
 * @returns An accessible avatar element.
 */
export function Avatar({ decorative = false, name, src, size = 'medium', className = '' }: AvatarProps) {
  return (
    <span aria-hidden={decorative || undefined} aria-label={decorative ? undefined : name} className={`${styles.avatar} ${styles[size]} ${className}`} role={decorative ? undefined : 'img'}>
      {src ? <img alt="" src={src} /> : initialsForName(name)}
    </span>
  );
}
