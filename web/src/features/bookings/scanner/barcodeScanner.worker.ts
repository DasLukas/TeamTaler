import { decodeBarcodeFrame, initializeBarcodeDecoder } from './barcodeDecoder';
import type { BarcodeWorkerRequest, BarcodeWorkerResponse } from './types';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<BarcodeWorkerRequest>) => void) | null;
  postMessage(message: BarcodeWorkerResponse): void;
};

/** Processes one bounded request; decoding is serialized by the camera controller. */
async function handle(request: BarcodeWorkerRequest): Promise<void> {
  try {
    if (request.type === 'initialize') {
      await initializeBarcodeDecoder();
      scope.postMessage({ type: 'ready' });
      return;
    }
    const { width, height, pixels } = request;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 720 || height > 720 || pixels.byteLength !== width * height * 4) throw new Error('Invalid scan frame.');
    const frame = { data: new Uint8ClampedArray(pixels), width, height, colorSpace: 'srgb' } as ImageData;
    const codes = await decodeBarcodeFrame(frame, request.barcodeOnly);
    scope.postMessage({ type: 'result', id: request.id, codes });
  } catch {
    scope.postMessage({ type: 'error' });
  }
}

scope.onmessage = (event) => { void handle(event.data); };
