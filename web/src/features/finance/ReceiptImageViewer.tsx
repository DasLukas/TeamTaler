import Download from 'lucide-react/dist/esm/icons/download';
import Minus from 'lucide-react/dist/esm/icons/minus';
import Plus from 'lucide-react/dist/esm/icons/plus';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import RotateCw from 'lucide-react/dist/esm/icons/rotate-cw';
import Scan from 'lucide-react/dist/esm/icons/scan';
import { useEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { imagePreviewGeometry, type ImageSize } from './receiptImageGeometry';
import styles from './ReceiptImageViewer.module.css';

const MIN_ZOOM = 50;
const MAX_ZOOM = 300;
const ZOOM_STEP = 25;

/** Properties accepted by the shared protected-receipt image viewer. */
export interface ReceiptImageViewerProps {
  fileName: string;
  src: string;
}

/**
 * Renders a responsive, scrollable image preview with accessible view controls and local download.
 *
 * @param props - Already-authorized object URL and original receipt filename.
 * @returns A toolbar and image viewport; all view changes stay browser-local.
 */
export function ReceiptImageViewer({ fileName, src }: ReceiptImageViewerProps) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [naturalSize, setNaturalSize] = useState<ImageSize>({ width: 0, height: 0 });
  const [viewportSize, setViewportSize] = useState<ImageSize>({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const measure = () => {
      const next = { width: viewport.clientWidth, height: viewport.clientHeight };
      setViewportSize((current) => current.width === next.width && current.height === next.height ? current : next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const geometry = imagePreviewGeometry(naturalSize, viewportSize, zoom, rotation);
  const canvasStyle: CSSProperties | undefined = geometry ? {
    width: Math.max(viewportSize.width, geometry.frameWidth),
    height: Math.max(viewportSize.height, geometry.frameHeight),
  } : undefined;
  const frameStyle: CSSProperties | undefined = geometry ? { width: geometry.frameWidth, height: geometry.frameHeight } : undefined;
  const imageStyle: CSSProperties | undefined = geometry ? {
    width: geometry.imageWidth,
    height: geometry.imageHeight,
    transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
  } : undefined;
  const onImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    setNaturalSize((current) => current.width === naturalWidth && current.height === naturalHeight ? current : { width: naturalWidth, height: naturalHeight });
  };
  const download = () => {
    const anchor = document.createElement('a');
    anchor.href = src;
    anchor.download = fileName.normalize('NFC').replace(/[\\/]/g, '_').replace(/\p{Cc}/gu, '_').slice(0, 180) || 'receipt';
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  };

  return <div className={styles.viewer}>
    <div aria-label={t('paymentAttachment.viewerToolbar')} className={styles.toolbar} role="toolbar">
      <div className={styles.viewControls}>
        <IconButton disabled={zoom <= MIN_ZOOM} label={t('paymentAttachment.zoomOut')} onClick={() => setZoom((current) => Math.max(MIN_ZOOM, current - ZOOM_STEP))} variant="surface"><Minus aria-hidden="true" size={19} /></IconButton>
        <output aria-live="polite" className={styles.zoom}>{zoom}%</output>
        <IconButton disabled={zoom >= MAX_ZOOM} label={t('paymentAttachment.zoomIn')} onClick={() => setZoom((current) => Math.min(MAX_ZOOM, current + ZOOM_STEP))} variant="surface"><Plus aria-hidden="true" size={19} /></IconButton>
        <span aria-hidden="true" className={styles.separator} />
        <IconButton label={t('paymentAttachment.rotateLeft')} onClick={() => setRotation((current) => (current + 270) % 360)} variant="surface"><RotateCcw aria-hidden="true" size={18} /></IconButton>
        <IconButton label={t('paymentAttachment.rotateRight')} onClick={() => setRotation((current) => (current + 90) % 360)} variant="surface"><RotateCw aria-hidden="true" size={18} /></IconButton>
        <IconButton disabled={zoom === 100 && rotation === 0} label={t('paymentAttachment.resetView')} onClick={() => { setZoom(100); setRotation(0); }} variant="surface"><Scan aria-hidden="true" size={18} /></IconButton>
      </div>
      <Button className={styles.download} leadingIcon={<Download size={18} />} onClick={download} size="small" variant="secondary">{t('paymentAttachment.download')}</Button>
    </div>
    <div className={styles.viewport} ref={viewportRef}>
      <div className={styles.canvas} style={canvasStyle}>
        <div className={styles.frame} style={frameStyle}>
          <img alt={fileName} className={geometry ? styles.image : styles.imageBeforeMeasure} onLoad={onImageLoad} src={src} style={imageStyle} />
        </div>
      </div>
    </div>
  </div>;
}
