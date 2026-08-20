import { applyPerspectiveTransform, createPerspectiveTransform, estimateWarpSize, isValidDocumentCorners } from './geometry';
import type { DocumentCorners, DocumentFilter, NormalizedPoint, PageRotation, ScannerPage } from './types';

const MAX_SOURCE_EDGE = 3000;
const WARP_MESH_SIZE = 18;

interface RenderedDocumentPage {
  blob: Blob;
  height: number;
  width: number;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('The browser could not encode the scanned page.'));
    }, type, quality);
  });
}

async function decodeBoundedBitmap(page: ScannerPage): Promise<ImageBitmap> {
  const sourceEdge = Math.max(page.sourceWidth, page.sourceHeight);
  if (sourceEdge <= MAX_SOURCE_EDGE) return createImageBitmap(page.file, { imageOrientation: 'from-image' });
  const scale = MAX_SOURCE_EDGE / sourceEdge;
  return createImageBitmap(page.file, {
    imageOrientation: 'from-image',
    resizeHeight: Math.max(1, Math.round(page.sourceHeight * scale)),
    resizeQuality: 'high',
    resizeWidth: Math.max(1, Math.round(page.sourceWidth * scale)),
  });
}

function interpolateQuad(corners: readonly NormalizedPoint[], horizontal: number, vertical: number): NormalizedPoint {
  const top = {
    x: corners[0].x + (corners[1].x - corners[0].x) * horizontal,
    y: corners[0].y + (corners[1].y - corners[0].y) * horizontal,
  };
  const bottom = {
    x: corners[3].x + (corners[2].x - corners[3].x) * horizontal,
    y: corners[3].y + (corners[2].y - corners[3].y) * horizontal,
  };
  return {
    x: top.x + (bottom.x - top.x) * vertical,
    y: top.y + (bottom.y - top.y) * vertical,
  };
}

interface AffineTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

function affineFromTriangles(source: readonly NormalizedPoint[], destination: readonly NormalizedPoint[]): AffineTransform | undefined {
  const denominator = source[0].x * (source[1].y - source[2].y)
    + source[1].x * (source[2].y - source[0].y)
    + source[2].x * (source[0].y - source[1].y);
  if (Math.abs(denominator) < 1e-6) return undefined;
  const solve = (first: number, second: number, third: number) => ({
    x: (first * (source[1].y - source[2].y) + second * (source[2].y - source[0].y) + third * (source[0].y - source[1].y)) / denominator,
    y: (first * (source[2].x - source[1].x) + second * (source[0].x - source[2].x) + third * (source[1].x - source[0].x)) / denominator,
    offset: (first * (source[1].x * source[2].y - source[2].x * source[1].y)
      + second * (source[2].x * source[0].y - source[0].x * source[2].y)
      + third * (source[0].x * source[1].y - source[1].x * source[0].y)) / denominator,
  });
  const horizontal = solve(destination[0].x, destination[1].x, destination[2].x);
  const vertical = solve(destination[0].y, destination[1].y, destination[2].y);
  return {
    a: horizontal.x,
    b: vertical.x,
    c: horizontal.y,
    d: vertical.y,
    e: horizontal.offset,
    f: vertical.offset,
  };
}

function renderTriangle(
  context: CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  source: readonly [NormalizedPoint, NormalizedPoint, NormalizedPoint],
  destination: readonly [NormalizedPoint, NormalizedPoint, NormalizedPoint],
): void {
  const affine = affineFromTriangles(source, destination);
  if (!affine) return;
  context.save();
  context.beginPath();
  context.moveTo(destination[0].x, destination[0].y);
  context.lineTo(destination[1].x, destination[1].y);
  context.lineTo(destination[2].x, destination[2].y);
  context.closePath();
  context.clip();
  context.setTransform(affine.a, affine.b, affine.c, affine.d, affine.e, affine.f);
  context.drawImage(bitmap, 0, 0);
  context.restore();
}

function filterValue(filter: DocumentFilter): string {
  switch (filter) {
    case 'color': return 'contrast(1.08) saturate(0.92) brightness(1.02)';
    case 'grayscale': return 'grayscale(1) contrast(1.16) brightness(1.04)';
    case 'original': return 'none';
  }
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
 * Perspective-corrects one source image and strips its original metadata.
 *
 * The fallback renderer uses a small projective triangle mesh. OpenCV is kept
 * out of the initial application bundle and is used independently by the edge
 * detection worker when its lazy chunk is available.
 *
 * @param page - Local source page and its non-destructive edit state.
 * @returns Metadata-free JPEG data and its final pixel dimensions.
 * @throws {Error} When the crop is invalid, decoding fails, or canvas APIs are unavailable.
 */
export async function renderDocumentPage(page: ScannerPage): Promise<RenderedDocumentPage> {
  if (!isValidDocumentCorners(page.corners)) throw new Error('The selected document corners do not form a valid page.');
  const bitmap = await decodeBoundedBitmap(page);
  try {
    const size = estimateWarpSize(page.corners, bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas rendering is unavailable.');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.filter = filterValue(page.filter);

    const sourcePixels = page.corners.map((point) => ({ x: point.x * bitmap.width, y: point.y * bitmap.height })) as unknown as DocumentCorners;
    const destination: DocumentCorners = [
      { x: 0, y: 0 },
      { x: size.width, y: 0 },
      { x: size.width, y: size.height },
      { x: 0, y: size.height },
    ];
    const transform = createPerspectiveTransform(sourcePixels, destination);

    for (let row = 0; row < WARP_MESH_SIZE; row += 1) {
      for (let column = 0; column < WARP_MESH_SIZE; column += 1) {
        const left = column / WARP_MESH_SIZE;
        const right = (column + 1) / WARP_MESH_SIZE;
        const top = row / WARP_MESH_SIZE;
        const bottom = (row + 1) / WARP_MESH_SIZE;
        const sourceTopLeft = interpolateQuad(sourcePixels, left, top);
        const sourceTopRight = interpolateQuad(sourcePixels, right, top);
        const sourceBottomRight = interpolateQuad(sourcePixels, right, bottom);
        const sourceBottomLeft = interpolateQuad(sourcePixels, left, bottom);
        const destinationTopLeft = applyPerspectiveTransform(transform, sourceTopLeft);
        const destinationTopRight = applyPerspectiveTransform(transform, sourceTopRight);
        const destinationBottomRight = applyPerspectiveTransform(transform, sourceBottomRight);
        const destinationBottomLeft = applyPerspectiveTransform(transform, sourceBottomLeft);
        renderTriangle(context, bitmap, [sourceTopLeft, sourceTopRight, sourceBottomRight], [destinationTopLeft, destinationTopRight, destinationBottomRight]);
        renderTriangle(context, bitmap, [sourceTopLeft, sourceBottomRight, sourceBottomLeft], [destinationTopLeft, destinationBottomRight, destinationBottomLeft]);
      }
    }

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
