import { detectDocumentPortable } from './portableDocumentDetection';
import type { DetectionRequest, DetectionResult, DetectionWorkerRequest } from './types';

interface DetectionWorkerScope {
  onmessage: ((event: MessageEvent<DetectionWorkerRequest>) => void) | null;
  postMessage(message: DetectionResult): void;
}

const workerScope = globalThis as unknown as DetectionWorkerScope;

function detect(request: DetectionRequest): void {
  const { frame, requestId } = request;
  try {
    const candidate = detectDocumentPortable(frame);
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

function initialize(): void {
  workerScope.postMessage({ confidence: 0, requestId: 0, status: 'ready' });
}

workerScope.onmessage = (event) => {
  if (event.data.type === 'initialize') initialize();
  else detect(event.data);
};

export {};
