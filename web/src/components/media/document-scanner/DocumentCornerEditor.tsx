import Contrast from 'lucide-react/dist/esm/icons/contrast';
import ImageIcon from 'lucide-react/dist/esm/icons/image';
import Palette from 'lucide-react/dist/esm/icons/palette';
import RotateCw from 'lucide-react/dist/esm/icons/rotate-cw';
import ScanLine from 'lucide-react/dist/esm/icons/scan-line';
import Undo2 from 'lucide-react/dist/esm/icons/undo-2';
import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '@/components/ui/IconButton';
import { constrainPoint, DEFAULT_DOCUMENT_CORNERS, isValidDocumentCorners } from './geometry';
import type { DocumentCorners, DocumentFilter, NormalizedPoint, PageRotation, ScannerPage } from './types';
import styles from './DocumentScannerWorkspace.module.css';

interface DocumentCornerEditorProps {
  page: ScannerPage;
  onChange: (page: ScannerPage) => void;
}

interface FrameSize {
  height: number;
  width: number;
}

const CORNER_NAMES = ['top left', 'top right', 'bottom right', 'bottom left'] as const;

function nextRotation(rotation: PageRotation): PageRotation {
  return ((rotation + 90) % 360) as PageRotation;
}

function rotatePoint(point: NormalizedPoint, rotation: PageRotation): NormalizedPoint {
  switch (rotation) {
    case 0: return point;
    case 90: return { x: 1 - point.y, y: point.x };
    case 180: return { x: 1 - point.x, y: 1 - point.y };
    case 270: return { x: point.y, y: 1 - point.x };
  }
}

function sourcePoint(point: NormalizedPoint, rotation: PageRotation): NormalizedPoint {
  return rotatePoint(point, ((360 - rotation) % 360) as PageRotation);
}

function containedFrameSize(width: number, height: number, aspect: number): FrameSize | undefined {
  if (width <= 0 || height <= 0 || !Number.isFinite(aspect) || aspect <= 0) return undefined;
  if (width / height > aspect) return { height, width: height * aspect };
  return { height: width / aspect, width };
}

/**
 * Renders an accessible four-corner crop editor for one scanner page.
 *
 * @param props - Current page and immutable page-change callback.
 * @returns A pointer and keyboard operated local page editor.
 */
export function DocumentCornerEditor({ page, onChange }: DocumentCornerEditorProps) {
  const { t } = useTranslation();
  const hintId = useId();
  const stageRef = useRef<HTMLDivElement>(null);
  const [frameSize, setFrameSize] = useState<FrameSize>();
  const displayCorners = page.corners.map((point) => rotatePoint(point, page.rotation)) as unknown as DocumentCorners;
  const quarterTurn = page.rotation === 90 || page.rotation === 270;
  const sourceAspect = page.sourceWidth / page.sourceHeight;
  const previewAspect = quarterTurn ? 1 / sourceAspect : sourceAspect;
  const imageStyle: CSSProperties = {
    height: quarterTurn ? `${previewAspect * 100}%` : '100%',
    transform: `translate(-50%, -50%) rotate(${page.rotation}deg)`,
    width: quarterTurn ? `${100 / previewAspect}%` : '100%',
  };

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const synchronize = () => {
      const bounds = stage.getBoundingClientRect();
      const next = containedFrameSize(bounds.width, bounds.height, previewAspect);
      setFrameSize((current) => {
        if (!next || (current && Math.abs(current.height - next.height) < 0.5 && Math.abs(current.width - next.width) < 0.5)) return current;
        return next;
      });
    };
    synchronize();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', synchronize);
      return () => window.removeEventListener('resize', synchronize);
    }
    const observer = new ResizeObserver(synchronize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [previewAspect]);

  const updateCorner = (index: number, point: NormalizedPoint) => {
    const next = [...page.corners] as [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint];
    next[index] = constrainPoint(point);
    if (isValidDocumentCorners(next)) onChange({ ...page, corners: next });
  };

  const movePointer = (index: number, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const frame = event.currentTarget.parentElement;
    if (!frame) return;
    const bounds = frame.getBoundingClientRect();
    updateCorner(index, sourcePoint({
      x: (event.clientX - bounds.left) / Math.max(1, bounds.width),
      y: (event.clientY - bounds.top) / Math.max(1, bounds.height),
    }, page.rotation));
  };

  const moveKeyboard = (index: number, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 0.04 : 0.01;
    const current = displayCorners[index];
    let point: NormalizedPoint;
    switch (event.key) {
      case 'ArrowLeft': point = { ...current, x: current.x - step }; break;
      case 'ArrowRight': point = { ...current, x: current.x + step }; break;
      case 'ArrowUp': point = { ...current, y: current.y - step }; break;
      case 'ArrowDown': point = { ...current, y: current.y + step }; break;
      default: return;
    }
    event.preventDefault();
    updateCorner(index, sourcePoint(point, page.rotation));
  };

  return (
    <section aria-label={t('documentScanner.pageEditor', { defaultValue: 'Page editor' })} className={styles.editorPanel}>
      <div className={styles.cornerStage} ref={stageRef}>
        <div className={styles.cornerFrame} style={{ aspectRatio: previewAspect, height: frameSize?.height, width: frameSize?.width }}>
          <img
            alt={t('documentScanner.pagePreview', { defaultValue: 'Selected scan page' })}
            data-rotation={page.rotation}
            src={page.previewUrl}
            style={imageStyle}
          />
          <svg aria-hidden="true" className={styles.cornerOverlay} preserveAspectRatio="none" viewBox="0 0 100 100">
            <polygon points={displayCorners.map((point) => `${point.x * 100},${point.y * 100}`).join(' ')} />
          </svg>
          {displayCorners.map((point, index) => (
            <button
              aria-describedby={hintId}
              aria-label={t('documentScanner.moveCorner', { corner: CORNER_NAMES[index], defaultValue: `Move ${CORNER_NAMES[index]} corner` })}
              className={styles.cornerHandle}
              key={CORNER_NAMES[index]}
              onKeyDown={(event) => moveKeyboard(index, event)}
              onPointerDown={(event) => {
                if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => movePointer(index, event)}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
              type="button"
            />
          ))}
        </div>
      </div>
      <p className={styles.accessibleEditorInstructions} id={hintId}>
        {t('documentScanner.cornerInstructions', { defaultValue: 'Drag each corner onto the document. Arrow keys move the focused corner; hold Shift for larger steps.' })}
      </p>
      <div className={styles.editorToolbar}>
        <p className={styles.editorPrompt}><ScanLine aria-hidden="true" size={17} />{t('documentScanner.cornerHint', { defaultValue: 'Move the corners onto the receipt' })}</p>
        <div aria-label={t('documentScanner.editActions', { defaultValue: 'Edit actions' })} className={styles.editorToolActions} role="group">
          <IconButton label={t('documentScanner.rotate', { defaultValue: 'Rotate' })} onClick={() => onChange({ ...page, rotation: nextRotation(page.rotation) })} variant="surface">
            <RotateCw size={19} />
          </IconButton>
          <IconButton label={t('documentScanner.resetCorners', { defaultValue: 'Reset corners' })} onClick={() => onChange({ ...page, corners: DEFAULT_DOCUMENT_CORNERS })} variant="surface">
            <Undo2 size={19} />
          </IconButton>
        </div>
        <fieldset className={styles.filterField}>
          <legend>{t('documentScanner.enhancement', { defaultValue: 'Enhancement' })}</legend>
          <div className={styles.filterOptions}>
            {([
              { icon: <Palette size={17} />, label: t('documentScanner.filterColorShort', { defaultValue: 'Color' }), value: 'color' },
              { icon: <Contrast size={17} />, label: t('documentScanner.filterGrayscaleShort', { defaultValue: 'Gray' }), value: 'grayscale' },
              { icon: <ImageIcon size={17} />, label: t('documentScanner.filterOriginal', { defaultValue: 'Original' }), value: 'original' },
            ] satisfies Array<{ icon: ReactNode; label: string; value: DocumentFilter }>).map((option) => (
              <button
                aria-pressed={page.filter === option.value}
                className={styles.filterOption}
                key={option.value}
                onClick={() => onChange({ ...page, filter: option.value })}
                type="button"
              >
                <span aria-hidden="true">{option.icon}</span>
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </fieldset>
      </div>
    </section>
  );
}
