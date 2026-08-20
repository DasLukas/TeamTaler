import type { DetectionRequest, DetectionResult, DocumentCorners, NormalizedPoint } from './types';

type OpenCvRuntime = Awaited<ReturnType<(typeof import('@opencvjs/web'))['loadOpenCV']>>;

interface DetectionWorkerScope {
  onmessage: ((event: MessageEvent<DetectionRequest>) => void) | null;
  postMessage(message: DetectionResult): void;
}

const workerScope = globalThis as unknown as DetectionWorkerScope;
let openCv: OpenCvRuntime | undefined;
let openCvLoadStarted = false;

function startOpenCvLoad(): void {
  if (openCvLoadStarted) return;
  openCvLoadStarted = true;
  void import('@opencvjs/web')
    .then(({ loadOpenCV }) => loadOpenCV())
    .then((runtime) => { openCv = runtime; })
    .catch(() => { openCv = undefined; });
}

function orderCorners(points: readonly NormalizedPoint[]): DocumentCorners {
  const bySum = [...points].sort((first, second) => first.x + first.y - second.x - second.y);
  const topLeft = bySum[0];
  const bottomRight = bySum[3];
  const remaining = bySum.slice(1, 3).sort((first, second) => first.y - first.x - (second.y - second.x));
  return [topLeft, remaining[0], bottomRight, remaining[1]];
}

function detectWithOpenCv(imageData: ImageData, runtime: OpenCvRuntime): Omit<DetectionResult, 'requestId'> | undefined {
  const source = runtime.matFromImageData(imageData);
  const gray = new runtime.Mat();
  const blurred = new runtime.Mat();
  const edges = new runtime.Mat();
  const contours = new runtime.MatVector();
  const hierarchy = new runtime.Mat();
  try {
    runtime.cvtColor(source, gray, runtime.COLOR_RGBA2GRAY);
    runtime.GaussianBlur(gray, blurred, new runtime.Size(5, 5), 0, 0, runtime.BORDER_DEFAULT);
    runtime.Canny(blurred, edges, 55, 160);
    runtime.findContours(edges, contours, hierarchy, runtime.RETR_LIST, runtime.CHAIN_APPROX_SIMPLE);
    const frameArea = imageData.width * imageData.height;
    let bestArea = 0;
    let bestCorners: DocumentCorners | undefined;
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index);
      const approximation = new runtime.Mat();
      try {
        const perimeter = runtime.arcLength(contour, true);
        runtime.approxPolyDP(contour, approximation, perimeter * 0.025, true);
        const area = Math.abs(runtime.contourArea(approximation));
        if (approximation.rows !== 4 || area <= bestArea || area < frameArea * 0.12) continue;
        const coordinates = approximation.data32S;
        const points: NormalizedPoint[] = [];
        for (let pointIndex = 0; pointIndex < 4; pointIndex += 1) {
          points.push({
            x: coordinates[pointIndex * 2] / imageData.width,
            y: coordinates[pointIndex * 2 + 1] / imageData.height,
          });
        }
        bestArea = area;
        bestCorners = orderCorners(points);
      } finally {
        approximation.delete();
        contour.delete();
      }
    }
    if (!bestCorners) return undefined;
    return {
      confidence: Math.min(1, 0.55 + bestArea / frameArea * 0.45),
      corners: bestCorners,
    };
  } finally {
    hierarchy.delete();
    contours.delete();
    edges.delete();
    blurred.delete();
    gray.delete();
    source.delete();
  }
}

function detectHighContrastBounds(imageData: ImageData): Omit<DetectionResult, 'requestId'> {
  const { data, width, height } = imageData;
  const step = Math.max(2, Math.floor(Math.max(width, height) / 180));
  let luminosityTotal = 0;
  let sampleCount = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const offset = (y * width + x) * 4;
      luminosityTotal += data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
      sampleCount += 1;
    }
  }
  const threshold = luminosityTotal / Math.max(1, sampleCount) + 18;
  let minimumX = width;
  let minimumY = height;
  let maximumX = 0;
  let maximumY = 0;
  let matches = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const offset = (y * width + x) * 4;
      const luminosity = data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
      if (luminosity < threshold) continue;
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
      matches += 1;
    }
  }
  const coverage = matches / Math.max(1, sampleCount);
  if (coverage < 0.08 || maximumX <= minimumX || maximumY <= minimumY) {
    return {
      confidence: 0.1,
      corners: [{ x: 0.06, y: 0.06 }, { x: 0.94, y: 0.06 }, { x: 0.94, y: 0.94 }, { x: 0.06, y: 0.94 }],
    };
  }
  return {
    confidence: Math.min(0.52, 0.25 + coverage * 0.45),
    corners: [
      { x: minimumX / width, y: minimumY / height },
      { x: maximumX / width, y: minimumY / height },
      { x: maximumX / width, y: maximumY / height },
      { x: minimumX / width, y: maximumY / height },
    ],
  };
}

workerScope.onmessage = (event) => {
  const request = event.data;
  if (request.type !== 'detect') return;
  const { bitmap, requestId } = request;
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Worker canvas rendering is unavailable.');
    context.drawImage(bitmap, 0, 0);
    const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const result = openCv ? detectWithOpenCv(imageData, openCv) : undefined;
    startOpenCvLoad();
    workerScope.postMessage({ requestId, ...(result ?? detectHighContrastBounds(imageData)) });
  } finally {
    bitmap.close();
  }
};

export {};
