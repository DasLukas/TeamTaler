import { useState, type ImgHTMLAttributes } from 'react';
import styles from './ManagedImage.module.css';
import { managedImageSources, supportsManagedImageVariants } from './managedImageSources';

/** Properties accepted by a decoded managed image. */
export interface ManagedImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'decoding' | 'src' | 'srcSet'> {
  /** Protected API image URL or an ordinary image URL used without variants. */
  src: string;
}

/** Properties accepted by a managed image with a stable visual fallback. */
export interface ManagedImageFrameProps extends ManagedImageProps {
  /** Text displayed while the image loads or when it cannot be loaded. */
  fallback: string;
  /** Class applied to the stable image frame rather than the nested image. */
  frameClassName?: string;
}

/**
 * Renders a responsive image only after the browser has fully decoded it.
 * Protected images use bounded WebP variants and retry the canonical PNG when
 * a variant endpoint is unavailable.
 *
 * @param props - Native image properties and the source URL.
 * @returns An image with stable decoded/loading/error presentation state.
 */
export function ManagedImage({ alt = '', className = '', fetchPriority, loading = 'lazy', onError, onLoad, sizes, src, ...rest }: ManagedImageProps) {
  const [decodedToken, setDecodedToken] = useState('');
  const [failedVariantSource, setFailedVariantSource] = useState('');
  const variantsSupported = supportsManagedImageVariants(src) && failedVariantSource !== src;
  const responsiveSources = variantsSupported ? managedImageSources(src) : undefined;
  const source = responsiveSources?.src ?? src;
  const sourceSet = responsiveSources?.srcSet;
  const sourceToken = `${src}|${variantsSupported ? 'responsive' : 'canonical'}`;
  const ready = decodedToken === sourceToken;

  const handleLoad: NonNullable<ManagedImageProps['onLoad']> = (event) => {
    onLoad?.(event);
    const image = event.currentTarget;
    const token = image.dataset.sourceToken ?? '';
    const decode = typeof image.decode === 'function' ? image.decode() : Promise.resolve();
    void decode.catch(() => undefined).then(() => {
      if (image.dataset.sourceToken === token && image.naturalWidth > 0) setDecodedToken(token);
    });
  };

  const handleError: NonNullable<ManagedImageProps['onError']> = (event) => {
    if (variantsSupported) {
      setFailedVariantSource(src);
      return;
    }
    onError?.(event);
  };

  return (
    <img
      {...rest}
      alt={alt}
      className={`${styles.image} ${className}`}
      data-managed-image-state={ready ? 'ready' : 'loading'}
      data-source-token={sourceToken}
      decoding="async"
      fetchPriority={fetchPriority}
      loading={loading}
      onError={handleError}
      onLoad={handleLoad}
      sizes={sourceSet ? sizes : undefined}
      src={source}
      srcSet={sourceSet}
    />
  );
}

/**
 * Renders a stable image frame whose fallback stays visible until the managed
 * image has completed download and decoding.
 *
 * @param props - Managed image properties, fallback text, and frame class.
 * @returns A stable frame containing the fallback and decoded image.
 */
export function ManagedImageFrame({ className = '', fallback, frameClassName = '', ...imageProps }: ManagedImageFrameProps) {
  return (
    <span className={`${styles.frame} ${frameClassName}`}>
      <span aria-hidden="true" className={styles.fallback}>{fallback}</span>
      <ManagedImage {...imageProps} className={className} />
    </span>
  );
}
