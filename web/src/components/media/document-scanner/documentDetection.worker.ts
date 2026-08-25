import { detectDocumentWithOpenCv, type OpenCvRuntime } from './openCvDocumentDetection';
import type { DetectionRequest, DetectionResult } from './types';

interface DetectionWorkerScope {
  onmessage: ((event: MessageEvent<DetectionRequest>) => void) | null;
  postMessage(message: DetectionResult): void;
}

const workerScope = globalThis as unknown as DetectionWorkerScope;
let openCvPromise: Promise<OpenCvRuntime> | undefined;

function loadOpenCv(): Promise<OpenCvRuntime> {
  openCvPromise ??= import('@opencvjs/web').then(({ loadOpenCV }) => loadOpenCV());
  return openCvPromise;
}

async function detect(request: DetectionRequest): Promise<void> {
  const { bitmap, requestId } = request;
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Worker canvas rendering is unavailable.');
    context.drawImage(bitmap, 0, 0);
    const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let runtime: OpenCvRuntime;
    try {
      runtime = await loadOpenCv();
    } catch {
      workerScope.postMessage({ confidence: 0, requestId, status: 'unavailable' });
      return;
    }
    let candidate: ReturnType<typeof detectDocumentWithOpenCv>;
    try {
      candidate = detectDocumentWithOpenCv(imageData, runtime);
    } catch {
      candidate = undefined;
    }
    workerScope.postMessage({
      confidence: candidate?.confidence ?? 0,
      corners: candidate?.corners,
      requestId,
      status: 'ready',
    });
  } catch {
    workerScope.postMessage({ confidence: 0, requestId, status: 'unavailable' });
  } finally {
    bitmap.close();
  }
}

workerScope.onmessage = (event) => {
  if (event.data.type === 'detect') void detect(event.data);
};

export {};
