import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { calculateImagePlacement, DEFAULT_IMAGE_TRANSFORM, type ImageTransform } from './imageUpload';
import styles from './ImageCropEditor.module.css';

/** Properties accepted by the reusable square image editor. */
export interface ImageCropEditorProps {
  /** Accessible description of the selected image preview. */
  alt: string;
  /** Applies a circular mask when the saved image will be displayed as an avatar. */
  circular?: boolean;
  /** Uses a compact preview and icon-only reset action for dense forms. */
  compact?: boolean;
  /** Locally selected source image. */
  file: File;
  /** Receives every position or zoom change. */
  onChange: (value: ImageTransform) => void;
  /** Current normalized crop position and zoom. */
  value: ImageTransform;
}

interface DragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startTransform: ImageTransform;
  frameWidth: number;
  frameHeight: number;
}

function clamp(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function clampZoom(value: number): number {
  return Math.max(1, Math.min(3, value));
}

/**
 * Renders an accessible, pointer-enabled square image crop editor.
 *
 * @param props - Source file, crop state, shape, and accessible preview text.
 * @returns A local image preview with drag, wheel, keyboard, and reset controls.
 */
export function ImageCropEditor({ alt, circular = false, compact = false, file, onChange, value }: ImageCropEditorProps) {
  const { t } = useTranslation();
  const hintId = useId();
  const [bitmap, setBitmap] = useState<ImageBitmap>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<DragState | undefined>(undefined);
  const transformRef = useRef(value);
  const placement = calculateImagePlacement(bitmap?.width ?? 1, bitmap?.height ?? 1, value);

  useEffect(() => {
    let active = true;
    let decodedBitmap: ImageBitmap | undefined;
    void createImageBitmap(file, { imageOrientation: 'from-image' }).then(
      (nextBitmap) => {
        decodedBitmap = nextBitmap;
        if (active) {
          setBitmap(nextBitmap);
        } else {
          nextBitmap.close();
        }
      },
      () => {
        if (active) setBitmap(undefined);
      },
    );
    return () => {
      active = false;
      decodedBitmap?.close();
    };
  }, [file]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const size = canvas.width;
    context.clearRect(0, 0, size, size);
    if (!bitmap) return;
    const width = placement.width * size;
    const height = placement.height * size;
    context.drawImage(
      bitmap,
      placement.centerX * size - width / 2,
      placement.centerY * size - height / 2,
      width,
      height,
    );
  }, [bitmap, placement.centerX, placement.centerY, placement.height, placement.width]);
  useEffect(() => {
    transformRef.current = value;
  }, [value]);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const zoom = (event: WheelEvent) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.002);
      const current = transformRef.current;
      const next = { ...current, zoom: clampZoom(current.zoom * factor) };
      transformRef.current = next;
      onChange(next);
    };
    frame.addEventListener('wheel', zoom, { passive: false });
    return () => frame.removeEventListener('wheel', zoom);
  }, [onChange]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !frameRef.current) return;
    const bounds = frameRef.current.getBoundingClientRect();
    frameRef.current.focus();
    frameRef.current.setPointerCapture(event.pointerId);
    dragState.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startTransform: value,
      frameWidth: bounds.width,
      frameHeight: bounds.height,
    };
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = placement.maxOffsetX > 0 ? (event.clientX - drag.startClientX) / drag.frameWidth / placement.maxOffsetX : 0;
    const deltaY = placement.maxOffsetY > 0 ? (event.clientY - drag.startClientY) / drag.frameHeight / placement.maxOffsetY : 0;
    onChange({
      ...value,
      x: clamp(drag.startTransform.x + deltaX),
      y: clamp(drag.startTransform.y + deltaY),
    });
  };

  const stopDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    if (frameRef.current?.hasPointerCapture(event.pointerId)) {
      frameRef.current.releasePointerCapture(event.pointerId);
    }
    dragState.current = undefined;
  };

  const useKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const positionStep = event.shiftKey ? 0.2 : 0.05;
    const zoomStep = event.shiftKey ? 0.25 : 0.1;
    let next: ImageTransform;
    switch (event.key) {
      case 'ArrowLeft':
        if (placement.maxOffsetX === 0) return;
        next = { ...value, x: clamp(value.x - positionStep) };
        break;
      case 'ArrowRight':
        if (placement.maxOffsetX === 0) return;
        next = { ...value, x: clamp(value.x + positionStep) };
        break;
      case 'ArrowUp':
        if (placement.maxOffsetY === 0) return;
        next = { ...value, y: clamp(value.y - positionStep) };
        break;
      case 'ArrowDown':
        if (placement.maxOffsetY === 0) return;
        next = { ...value, y: clamp(value.y + positionStep) };
        break;
      case '+':
      case '=': next = { ...value, zoom: clampZoom(value.zoom + zoomStep) }; break;
      case '-': next = { ...value, zoom: clampZoom(value.zoom - zoomStep) }; break;
      case 'Home': next = DEFAULT_IMAGE_TRANSFORM; break;
      default: return;
    }
    event.preventDefault();
    onChange(next);
  };

  return (
    <div className={`${styles.editor} ${compact ? styles.compact : ''}`}>
      <div
        aria-label={alt}
        aria-describedby={hintId}
        className={`${styles.preview} ${circular ? styles.circular : ''}`}
        onKeyDown={useKeyboard}
        onPointerCancel={stopDrag}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={stopDrag}
        ref={frameRef}
        role="img"
        tabIndex={0}
      >
        <canvas aria-hidden="true" height={512} ref={canvasRef} width={512} />
      </div>
      <p className={styles.hint} id={hintId}>{t('imageEditor.hint')} <span className={styles.assistive}>{t('imageEditor.keyboardHint')}</span></p>
      <Button leadingIcon={<RotateCcw size={16} />} onClick={() => onChange(DEFAULT_IMAGE_TRANSFORM)} size="small" variant="ghost">
        {t('imageEditor.reset')}
      </Button>
    </div>
  );
}
