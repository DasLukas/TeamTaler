import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startKioskCamera } from './camera';
import type { BarcodeWorkerRequest, BarcodeWorkerResponse } from './types';

class FakeWorker {
  static instance: FakeWorker;
  onmessage?: (event: MessageEvent<BarcodeWorkerResponse>) => void;
  onerror?: () => void;
  postMessage = vi.fn<(message: BarcodeWorkerRequest) => void>();
  terminate = vi.fn();
  constructor() { FakeWorker.instance = this; }
  reply(data: BarcodeWorkerResponse) { this.onmessage?.({ data } as MessageEvent<BarcodeWorkerResponse>); }
}

function fixture(deferred = false) {
  const video = document.createElement('video');
  const region = document.createElement('div');
  Object.defineProperties(video, { videoWidth: { value: 640 }, videoHeight: { value: 480 }, readyState: { value: 2 } });
  video.getBoundingClientRect = () => ({ x: 0, y: 0, width: 640, height: 480 }) as DOMRect;
  region.getBoundingClientRect = () => ({ x: 200, y: 120, width: 240, height: 240 }) as DOMRect;
  Object.defineProperties(region, { clientWidth: { value: 240 }, clientHeight: { value: 240 } });
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  let resolve!: (stream: MediaStream) => void;
  const permission = new Promise<MediaStream>((done) => { resolve = done; });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(() => deferred ? permission : Promise.resolve(stream)) } });
  const options = { video, region, barcodeOnly: false, isBlocked: vi.fn(() => false), onCodes: vi.fn(), onSuspend: vi.fn(), onReady: vi.fn(), onError: vi.fn() };
  return { ...options, options, track, stream, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray(240 * 240 * 4) }),
  }) as unknown as CanvasRenderingContext2D);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(navigator, 'mediaDevices'); });

describe('camera ownership and stale-frame protection', () => {
  it('stops permission results that arrive after the scanner closes', async () => {
    const f = fixture(true);
    const stop = startKioskCamera(f.options);
    stop(); stop();
    f.resolve(f.stream);
    await Promise.resolve();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(FakeWorker.instance.terminate).toHaveBeenCalledOnce();
    expect(f.video.srcObject).toBeNull();
    expect(f.onError).not.toHaveBeenCalled();
  });

  it.each(['interaction', 'layout'])('drops a frame after %s changes, without restarting the camera', async (change) => {
    const f = fixture();
    const stop = startKioskCamera(f.options);
    const worker = FakeWorker.instance;
    worker.reply({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(900);
    const request = worker.postMessage.mock.calls.find(([message]) => message.type === 'decode')![0];
    expect(request.type).toBe('decode');
    if (request.type !== 'decode') throw new Error('Missing frame');
    await vi.advanceTimersByTimeAsync(1000);
    expect(worker.postMessage.mock.calls.filter(([message]) => message.type === 'decode')).toHaveLength(1);
    if (change === 'interaction') f.isBlocked.mockReturnValue(true);
    else f.video.dispatchEvent(new Event('resize'));
    worker.reply({ type: 'result', id: request.id, codes: [{ value: 'new-product', format: 'QR_CODE' }] });
    expect(f.onCodes).not.toHaveBeenCalled();
    expect(f.onSuspend).toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    stop();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases the camera when worker initialization times out', async () => {
    const f = fixture();
    startKioskCamera(f.options);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(f.onError).toHaveBeenCalledOnce();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(FakeWorker.instance.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
