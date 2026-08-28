import { createPerspectiveTransform, estimateWarpSize, isValidDocumentCorners } from './geometry';
import { applyDocumentFilter } from './documentFilters';
import type { DocumentCorners, PageRotation, ScannerPage } from './types';

const MAX_SOURCE_EDGE = 3000;

interface RenderedDocumentPage {
  blob: Blob;
  height: number;
  width: number;
}

/** Source fields required to build a filter-only editor preview. */
export type DocumentFilterPreviewSource = Pick<ScannerPage, 'file' | 'filter' | 'sourceHeight' | 'sourceWidth'>;

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('The browser could not encode the scanned page.'));
    }, type, quality);
  });
}

async function decodeBoundedBitmap(page: DocumentFilterPreviewSource, maximumEdge = MAX_SOURCE_EDGE): Promise<ImageBitmap> {
  const boundedEdge = Math.max(32, Math.min(MAX_SOURCE_EDGE, maximumEdge));
  const sourceEdge = Math.max(page.sourceWidth, page.sourceHeight);
  if (sourceEdge <= boundedEdge) return createImageBitmap(page.file, { imageOrientation: 'from-image' });
  const scale = boundedEdge / sourceEdge;
  return createImageBitmap(page.file, {
    imageOrientation: 'from-image',
    resizeHeight: Math.max(1, Math.round(page.sourceHeight * scale)),
    resizeQuality: 'high',
    resizeWidth: Math.max(1, Math.round(page.sourceWidth * scale)),
  });
}

function applyCanvasFilter(canvas: HTMLCanvasElement, page: Pick<ScannerPage, 'filter'>): void {
  if (page.filter === 'original') return;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas pixel processing is unavailable.');
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  applyDocumentFilter(image, page.filter);
  context.putImageData(image, 0, 0);
}

function renderPerspectiveBitmap(
  bitmap: ImageBitmap,
  corners: DocumentCorners,
  size: { height: number; width: number },
  filter: ScannerPage['filter'],
): HTMLCanvasElement {
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = bitmap.width;
  sourceCanvas.height = bitmap.height;
  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) throw new Error('Canvas pixel processing is unavailable.');
  sourceContext.drawImage(bitmap, 0, 0);
  const source = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);

  const output = document.createElement('canvas');
  output.width = size.width;
  output.height = size.height;
  const outputContext = output.getContext('2d');
  if (!outputContext) throw new Error('Canvas rendering is unavailable.');
  const rendered = outputContext.createImageData(size.width, size.height);
  const maximumSourceX = Math.max(0, source.width - 1);
  const maximumSourceY = Math.max(0, source.height - 1);
  const sourcePixels = corners.map((point) => ({
    x: point.x * maximumSourceX,
    y: point.y * maximumSourceY,
  })) as unknown as DocumentCorners;
  const maximumOutputX = Math.max(1, size.width - 1);
  const maximumOutputY = Math.max(1, size.height - 1);
  const outputPixels: DocumentCorners = [
    { x: 0, y: 0 },
    { x: maximumOutputX, y: 0 },
    { x: maximumOutputX, y: maximumOutputY },
    { x: 0, y: maximumOutputY },
  ];
  const inverseTransform = createPerspectiveTransform(outputPixels, sourcePixels);
  const sourceData = source.data;
  const renderedData = rendered.data;

  for (let y = 0; y < size.height; y += 1) {
    let horizontalNumerator = inverseTransform[1] * y + inverseTransform[2];
    let verticalNumerator = inverseTransform[4] * y + inverseTransform[5];
    let denominator = inverseTransform[7] * y + inverseTransform[8];
    for (let x = 0; x < size.width; x += 1) {
      const sourceX = Math.max(0, Math.min(maximumSourceX, horizontalNumerator / denominator));
      const sourceY = Math.max(0, Math.min(maximumSourceY, verticalNumerator / denominator));
      const firstX = Math.floor(sourceX);
      const firstY = Math.floor(sourceY);
      const secondX = Math.min(maximumSourceX, firstX + 1);
      const secondY = Math.min(maximumSourceY, firstY + 1);
      const horizontalWeight = sourceX - firstX;
      const verticalWeight = sourceY - firstY;
      const topLeftWeight = (1 - horizontalWeight) * (1 - verticalWeight);
      const topRightWeight = horizontalWeight * (1 - verticalWeight);
      const bottomLeftWeight = (1 - horizontalWeight) * verticalWeight;
      const bottomRightWeight = horizontalWeight * verticalWeight;
      const topLeftOffset = (firstY * source.width + firstX) * 4;
      const topRightOffset = (firstY * source.width + secondX) * 4;
      const bottomLeftOffset = (secondY * source.width + firstX) * 4;
      const bottomRightOffset = (secondY * source.width + secondX) * 4;
      const outputOffset = (y * size.width + x) * 4;
      const alpha = (
        sourceData[topLeftOffset + 3] * topLeftWeight
        + sourceData[topRightOffset + 3] * topRightWeight
        + sourceData[bottomLeftOffset + 3] * bottomLeftWeight
        + sourceData[bottomRightOffset + 3] * bottomRightWeight
      ) / 255;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = sourceData[topLeftOffset + channel] * topLeftWeight
          + sourceData[topRightOffset + channel] * topRightWeight
          + sourceData[bottomLeftOffset + channel] * bottomLeftWeight
          + sourceData[bottomRightOffset + channel] * bottomRightWeight;
        renderedData[outputOffset + channel] = Math.round(value * alpha + 255 * (1 - alpha));
      }
      renderedData[outputOffset + 3] = 255;
      horizontalNumerator += inverseTransform[0];
      verticalNumerator += inverseTransform[3];
      denominator += inverseTransform[6];
    }
  }
  if (filter !== 'original') applyDocumentFilter(rendered, filter);
  outputContext.putImageData(rendered, 0, 0);
  return output;
}

function rotateCanvas(source: HTMLCanvasElement, rotation: PageRotation): HTMLCanvasElement {
  if (rotation === 0) return source;
  const output = document.createElement('canvas');
  const swapsDimensions = rotation === 90 || rotation === 270;
  output.width = swapsDimensions ? source.height : source.width;
  output.height = swapsDimensions ? source.width : source.height;
  const context = output.getContext('2d');
  if (!context) throw new Error('Canvas rendering is unavailable.');
  context.translate(output.width / 2, output.height / 2);
  context.rotate(rotation * Math.PI / 180);
  context.drawImage(source, -source.width / 2, -source.height / 2);
  return output;
}

/**
 * Produces a bounded editor preview with the exact enhancement used by PDF export.
 *
 * The source remains uncropped so corner handles continue to address original
 * image coordinates. Perspective correction is intentionally deferred to PDF
 * generation, while tonal and grayscale processing share the production pixel
 * implementation byte-for-byte.
 *
 * @param page - Scanner page whose file and filter should be previewed.
 * @param maximumEdge - Maximum preview edge in pixels; defaults to 1200.
 * @returns A metadata-free JPEG preview blob.
 * @throws {Error} When decoding, pixel processing, or JPEG encoding fails.
 */
export async function renderDocumentFilterPreview(page: DocumentFilterPreviewSource, maximumEdge = 1_200): Promise<Blob> {
  const bitmap = await decodeBoundedBitmap(page, maximumEdge);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas rendering is unavailable.');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0);
    applyCanvasFilter(canvas, page);
    return canvasToBlob(canvas, 'image/jpeg', 0.88);
  } finally {
    bitmap.close();
  }
}

/**
 * Perspective-corrects one source image and strips its original metadata.
 *
 * An inverse homography samples every output pixel exactly once, preventing
 * browser-dependent seams between independently clipped mesh triangles.
 * OpenCV remains isolated to the document-detection worker.
 *
 * @param page - Local source page and its non-destructive edit state.
 * @param maximumEdge - Maximum decoded source edge; defaults to 3000 pixels.
 * @returns Metadata-free JPEG data and its final pixel dimensions.
 * @throws {Error} When the crop is invalid, decoding fails, or canvas APIs are unavailable.
 */
export async function renderDocumentPage(page: ScannerPage, maximumEdge = MAX_SOURCE_EDGE): Promise<RenderedDocumentPage> {
  if (!isValidDocumentCorners(page.corners)) throw new Error('The selected document corners do not form a valid page.');
  const bitmap = await decodeBoundedBitmap(page, maximumEdge);
  try {
    const size = estimateWarpSize(page.corners, bitmap.width, bitmap.height);
    const canvas = renderPerspectiveBitmap(bitmap, page.corners, size, page.filter);
    const rotated = rotateCanvas(canvas, page.rotation);
    return {
      blob: await canvasToBlob(rotated, 'image/jpeg', 0.9),
      height: rotated.height,
      width: rotated.width,
    };
  } finally {
    bitmap.close();
  }
}
