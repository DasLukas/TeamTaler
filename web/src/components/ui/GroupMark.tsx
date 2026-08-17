import { useState, type HTMLAttributes } from 'react';
import styles from './GroupMark.module.css';

/** Properties accepted by the reusable group-logo mark. */
export interface GroupMarkProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  decorative?: boolean;
  imageUrl?: string;
  name: string;
}

/**
 * Renders a group logo with a stable first-letter fallback.
 *
 * @param props - Group name, optional protected image URL, accessibility mode,
 * and standard span attributes.
 * @returns A square group mark that falls back when the image is absent or fails.
 */
export function GroupMark({ className = '', decorative = false, imageUrl, name, ...rest }: GroupMarkProps) {
  const [failedImageUrl, setFailedImageUrl] = useState<string>();
  const initial = name.trim().slice(0, 1).toLocaleUpperCase() || '?';
  const showImage = Boolean(imageUrl && failedImageUrl !== imageUrl);

  return (
    <span
      {...rest}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : name}
      className={`${styles.mark} ${showImage ? styles.withImage : ''} ${className}`}
      role={decorative ? undefined : 'img'}
    >
      <span>{initial}</span>
      {showImage ? <img alt="" onError={() => setFailedImageUrl(imageUrl)} src={imageUrl} /> : null}
    </span>
  );
}
