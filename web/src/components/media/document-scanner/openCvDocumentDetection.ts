import { assessDocumentCandidate, type DocumentCandidate } from './documentDetection';
import type { NormalizedPoint } from './types';

/** Loaded OpenCV.js runtime used by the scanner detection worker. */
export type OpenCvRuntime = Awaited<ReturnType<(typeof import('@opencvjs/web'))['loadOpenCV']>>;

/**
 * Detects the best document-like quadrilateral in one RGBA frame.
 *
 * Optional OpenCV primitives degrade to compatible alternatives: CLAHE falls
 * back to histogram equalization and morphological closing falls back to the
 * raw Canny edge map. Every allocated OpenCV object is released before return.
 *
 * @param imageData - Bounded RGBA camera frame.
 * @param runtime - Fully initialized OpenCV.js runtime.
 * @returns The highest-scoring document candidate, or `undefined` when no safe contour exists.
 *
 * @example
 * const candidate = detectDocumentWithOpenCv(frame, await loadOpenCV());
 */
export function detectDocumentWithOpenCv(imageData: ImageData, runtime: OpenCvRuntime): DocumentCandidate | undefined {
  const source = runtime.matFromImageData(imageData);
  const gray = new runtime.Mat();
  const enhanced = new runtime.Mat();
  const blurred = new runtime.Mat();
  const edges = new runtime.Mat();
  const closedEdges = new runtime.Mat();
  const contours = new runtime.MatVector();
  const hierarchy = new runtime.Mat();
  let kernel: InstanceType<OpenCvRuntime['Mat']> | undefined;
  let contrast: { apply(source: InstanceType<OpenCvRuntime['Mat']>, destination: InstanceType<OpenCvRuntime['Mat']>): void; delete(): void } | undefined;
  try {
    runtime.cvtColor(source, gray, runtime.COLOR_RGBA2GRAY);
    let contrastApplied = false;
    if (typeof runtime.createCLAHE === 'function') {
      try {
        const nextContrast = runtime.createCLAHE(2.2, new runtime.Size(8, 8)) as typeof contrast;
        if (nextContrast) {
          contrast = nextContrast;
          contrast.apply(gray, enhanced);
          contrastApplied = true;
        }
      } catch {
        contrast?.delete();
        contrast = undefined;
      }
    }
    if (!contrastApplied) runtime.equalizeHist(gray, enhanced);
    runtime.GaussianBlur(enhanced, blurred, new runtime.Size(5, 5), 0, 0, runtime.BORDER_DEFAULT);
    runtime.Canny(blurred, edges, 45, 135);
    try {
      kernel = runtime.getStructuringElement(runtime.MORPH_RECT, new runtime.Size(5, 5));
      runtime.morphologyEx(edges, closedEdges, runtime.MORPH_CLOSE, kernel);
    } catch {
      kernel?.delete();
      kernel = undefined;
      edges.copyTo(closedEdges);
    }
    runtime.findContours(closedEdges, contours, hierarchy, runtime.RETR_LIST, runtime.CHAIN_APPROX_SIMPLE);

    let best: DocumentCandidate | undefined;
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index);
      const approximation = new runtime.Mat();
      try {
        const perimeter = runtime.arcLength(contour, true);
        runtime.approxPolyDP(contour, approximation, perimeter * 0.022, true);
        if (approximation.rows !== 4) continue;
        if (typeof runtime.isContourConvex === 'function' && !runtime.isContourConvex(approximation)) continue;
        const coordinates = approximation.data32S;
        const points: NormalizedPoint[] = [];
        for (let pointIndex = 0; pointIndex < 4; pointIndex += 1) {
          points.push({ x: coordinates[pointIndex * 2], y: coordinates[pointIndex * 2 + 1] });
        }
        const candidate = assessDocumentCandidate(
          points,
          imageData.width,
          imageData.height,
          Math.abs(runtime.contourArea(approximation)),
        );
        if (candidate && (!best || candidate.confidence > best.confidence)) best = candidate;
      } finally {
        approximation.delete();
        contour.delete();
      }
    }
    return best;
  } finally {
    contrast?.delete();
    kernel?.delete();
    hierarchy.delete();
    contours.delete();
    closedEdges.delete();
    edges.delete();
    blurred.delete();
    enhanced.delete();
    gray.delete();
    source.delete();
  }
}
