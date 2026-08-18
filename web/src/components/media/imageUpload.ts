/**
 * Formats an effective upload limit for concise localized form guidance.
 *
 * @param bytes - Positive byte limit returned by instance capabilities.
 * @param locale - Number-format locale, defaulting to the German interface.
 * @returns A human-readable KiB or MiB limit.
 */
export function formatMediaUploadLimit(bytes: number, locale = 'de-DE'): string {
  const unit = bytes >= 1024 * 1024 ? 'MiB' : 'KiB';
  const divisor = unit === 'MiB' ? 1024 * 1024 : 1024;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(bytes / divisor)} ${unit}`;
}

/** Source-image media types accepted by the browser and API. */
export const ACCEPTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Position and scale applied to a square image crop. */
export interface ImageTransform {
  /** Horizontal position between the leftmost and rightmost valid crop. */
  x: number;
  /** Vertical position between the topmost and bottommost valid crop. */
  y: number;
  /** Scale relative to the smallest square-covering size. */
  zoom: number;
}

/** Default transform showing the centered, smallest square-covering crop. */
export const DEFAULT_IMAGE_TRANSFORM: ImageTransform = { x: 0, y: 0, zoom: 1 };

/** Render placement for an image inside a normalized square frame. */
export interface ImagePlacement {
  /** Rendered width relative to the frame width. */
  width: number;
  /** Rendered height relative to the frame height. */
  height: number;
  /** Horizontal center relative to the frame width. */
  centerX: number;
  /** Vertical center relative to the frame height. */
  centerY: number;
  /** Available horizontal center movement relative to the frame width. */
  maxOffsetX: number;
  /** Available vertical center movement relative to the frame height. */
  maxOffsetY: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Calculates a gap-free square-cover placement for an image.
 *
 * @param sourceWidth - Natural source width in pixels.
 * @param sourceHeight - Natural source height in pixels.
 * @param transform - Normalized crop position and zoom.
 * @returns Relative dimensions and center coordinates for preview or canvas rendering.
 * @throws {Error} When a source dimension is not positive.
 *
 * @example
 * `calculateImagePlacement(1600, 900, { x: 0, y: 0, zoom: 1 })`
 */
export function calculateImagePlacement(sourceWidth: number, sourceHeight: number, transform: ImageTransform): ImagePlacement {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error('Image dimensions must be positive.');
  }
  const aspectRatio = sourceWidth / sourceHeight;
  const coverWidth = aspectRatio >= 1 ? aspectRatio : 1;
  const coverHeight = aspectRatio >= 1 ? 1 : 1 / aspectRatio;
  const zoom = clamp(transform.zoom, 1, 3);
  const width = coverWidth * zoom;
  const height = coverHeight * zoom;
  const maxOffsetX = Math.max(0, (width - 1) / 2);
  const maxOffsetY = Math.max(0, (height - 1) / 2);

  return {
    width,
    height,
    centerX: 0.5 + clamp(transform.x, -1, 1) * maxOffsetX,
    centerY: 0.5 + clamp(transform.y, -1, 1) * maxOffsetY,
    maxOffsetX,
    maxOffsetY,
  };
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('The selected image could not be decoded.'));
    };
    image.src = url;
  });
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error('The selected image could not be prepared.'));
    }, 'image/png');
  });
}

/**
 * Bakes the selected square crop into a metadata-free PNG upload.
 *
 * @param file - Browser-selected JPEG, PNG, or WebP source file.
 * @param transform - Normalized crop position and zoom chosen by the user.
 * @param outputSize - Square output size in pixels, defaulting to 1024.
 * @returns A PNG file containing exactly the visible crop.
 * @throws {Error} When the source cannot be decoded or the canvas cannot be encoded.
 *
 * @example
 * `await prepareSquareImage(file, { x: 0, y: -0.2, zoom: 1.4 })`
 */
export async function prepareSquareImage(file: File, transform: ImageTransform, outputSize = 1024): Promise<File> {
  const image = await loadImage(file);
  const placement = calculateImagePlacement(image.naturalWidth, image.naturalHeight, transform);
  const canvas = document.createElement('canvas');
  canvas.width = outputSize;
  canvas.height = outputSize;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Canvas rendering is unavailable.');
  }

  const width = placement.width * outputSize;
  const height = placement.height * outputSize;
  context.drawImage(
    image,
    placement.centerX * outputSize - width / 2,
    placement.centerY * outputSize - height / 2,
    width,
    height,
  );
  const blob = await canvasBlob(canvas);
  const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
  return new File([blob], `${baseName}.png`, { type: 'image/png', lastModified: Date.now() });
}
