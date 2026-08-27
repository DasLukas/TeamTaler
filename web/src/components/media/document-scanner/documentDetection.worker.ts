import { detectDocumentWithOpenCv, type OpenCvRuntime } from './openCvDocumentDetection';
import type { DetectionRequest, DetectionResult, DetectionWorkerRequest } from './types';

interface DetectionWorkerScope {
  onmessage: ((event: MessageEvent<DetectionWorkerRequest>) => void) | null;
  postMessage(message: DetectionResult): void;
}

const workerScope = globalThis as unknown as DetectionWorkerScope;
let openCvPromise: Promise<OpenCvRuntime> | undefined;

function loadOpenCv(): Promise<OpenCvRuntime> {
  openCvPromise ??= import('@opencvjs/web').then(({ loadOpenCV }) => loadOpenCV());
  return openCvPromise;
}

async function detect(request: DetectionRequest): Promise<void> {
  const { imageData, requestId } = request;
  try {
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
  }
}

async function initialize(): Promise<void> {
  try {
    await loadOpenCv();
    workerScope.postMessage({ confidence: 0, requestId: 0, status: 'ready' });
  } catch {
    workerScope.postMessage({ confidence: 0, requestId: 0, status: 'unavailable' });
  }
}

workerScope.onmessage = (event) => {
  if (event.data.type === 'initialize') void initialize();
  else void detect(event.data);
};

export {};
