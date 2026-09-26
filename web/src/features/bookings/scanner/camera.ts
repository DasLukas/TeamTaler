import { getScanCrop } from './geometry';
import type { BarcodeWorkerRequest, BarcodeWorkerResponse, ScannedCode } from './types';

/** Camera ownership and callbacks for one mounted scanner session. */
export interface KioskCameraOptions {
  video: HTMLVideoElement;
  region: HTMLElement;
  barcodeOnly: boolean;
  isBlocked: () => boolean;
  onCodes: (codes: ScannedCode[]) => void;
  onSuspend: () => void;
  onReady: () => void;
  onError: () => void;
}

/**
 * Starts one camera and worker, decodes only the visible scan area, and drops stale frames.
 * @param options - Stable elements and synchronous callbacks for current booking state.
 * @returns An idempotent disposer that stops every track, timer, observer and worker.
 * @throws Never synchronously; failures call onError and release acquired resources.
 */
export function startKioskCamera(options: KioskCameraOptions): () => void {
  const { video, region } = options;
  let disposed = false;
  let ready = false;
  let announced = false;
  let worker: Worker | undefined;
  let stream: MediaStream | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let version = 0;
  let pending: { id: number; version: number; geometry: string } | undefined;
  let requestId = 0;
  let previousGeometry = '';
  let settleUntil = 0;
  const canvas = document.createElement('canvas');
  let context: CanvasRenderingContext2D | null = null;

  const suspend = () => { version += 1; settleUntil = performance.now() + 500; options.onSuspend(); };
  const stop = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    clearTimeout(deadline);
    resizeObserver?.disconnect();
    document.removeEventListener('visibilitychange', suspend);
    video.removeEventListener('resize', suspend);
    worker?.terminate();
    stream?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  };
  const fail = () => { if (!disposed) { stop(); options.onError(); } };
  const geometry = () => {
    const rect = region.getBoundingClientRect();
    return getScanCrop({ width: video.videoWidth, height: video.videoHeight }, video.getBoundingClientRect(), {
      x: rect.x + region.clientLeft, y: rect.y + region.clientTop, width: region.clientWidth, height: region.clientHeight,
    });
  };
  const schedule = () => { if (!disposed) timer = setTimeout(capture, 150); };
  const capture = () => {
    if (disposed || pending) return;
    if (!ready || video.readyState < 2) { schedule(); return; }
    if (!announced) { announced = true; options.onReady(); }
    const crop = geometry();
    const key = JSON.stringify(crop);
    if (key !== previousGeometry) { previousGeometry = key; suspend(); }
    if (!crop || document.hidden || options.isBlocked() || performance.now() < settleUntil) {
      options.onSuspend();
      schedule();
      return;
    }
    try {
      const scale = Math.min(1, 720 / Math.max(crop.width, crop.height));
      canvas.width = Math.max(1, Math.floor(crop.width * scale));
      canvas.height = Math.max(1, Math.floor(crop.height * scale));
      context!.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
      const pixels = context!.getImageData(0, 0, canvas.width, canvas.height).data.buffer as ArrayBuffer;
      pending = { id: ++requestId, version, geometry: key };
      const message: BarcodeWorkerRequest = { type: 'decode', id: pending.id, pixels, width: canvas.width, height: canvas.height, barcodeOnly: options.barcodeOnly };
      deadline = setTimeout(fail, 5_000);
      worker!.postMessage(message, [pixels]);
    } catch { fail(); }
  };

  try {
    context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context || !navigator.mediaDevices?.getUserMedia) throw new Error('Camera unavailable.');
    worker = new Worker(new URL('./barcodeScanner.worker.ts', import.meta.url), { type: 'module' });
    worker.onerror = fail;
    worker.onmessageerror = fail;
    worker.onmessage = ({ data }: MessageEvent<BarcodeWorkerResponse>) => {
      if (disposed) return;
      if (data.type === 'error') { fail(); return; }
      if (data.type === 'ready') {
        ready = true;
        clearTimeout(deadline);
        return;
      }
      if (!pending || data.id !== pending.id) return;
      clearTimeout(deadline);
      if (pending.version === version && pending.geometry === JSON.stringify(geometry()) && !document.hidden && !options.isBlocked()) {
        options.onCodes(data.codes);
      } else options.onSuspend();
      pending = undefined;
      schedule();
    };
    deadline = setTimeout(fail, 10_000);
    worker.postMessage({ type: 'initialize' } satisfies BarcodeWorkerRequest);
    resizeObserver = new ResizeObserver(suspend);
    resizeObserver.observe(video);
    resizeObserver.observe(region);
    document.addEventListener('visibilitychange', suspend);
    video.addEventListener('resize', suspend);
    void navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } }).then(async (acquired) => {
      if (disposed) { acquired.getTracks().forEach((track) => track.stop()); return; }
      stream = acquired;
      stream.getVideoTracks().forEach((track) => track.addEventListener('ended', fail, { once: true }));
      video.srcObject = stream;
      await video.play();
      if (!disposed) schedule();
    }).catch(fail);
  } catch { queueMicrotask(fail); }
  return stop;
}
