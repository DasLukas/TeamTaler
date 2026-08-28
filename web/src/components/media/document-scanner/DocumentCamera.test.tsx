import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { captureDocumentFrame, createDetectionFrame } from './cameraUtils';
import { DocumentCamera } from './DocumentCamera';
import { DEFAULT_DOCUMENT_CORNERS } from './geometry';
import type { DetectionResult } from './types';

vi.mock('./cameraUtils', () => ({
  captureDocumentFrame: vi.fn(),
  createDetectionFrame: vi.fn(),
  stopDocumentCamera: (stream?: MediaStream) => stream?.getTracks().forEach((track) => track.stop()),
  supportsDocumentCamera: () => true,
}));

class MockWorker {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent<DetectionResult>) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
}

const workers: MockWorker[] = [];

function mediaStream() {
  const stop = vi.fn();
  return {
    stop,
    stream: { getTracks: () => [{ stop }] } as unknown as MediaStream,
  };
}

function initializeWorker(worker: MockWorker): void {
  act(() => worker.onmessage?.(new MessageEvent<DetectionResult>('message', { data: {
    confidence: 0,
    requestId: 0,
    status: 'ready',
  } })));
}

describe('DocumentCamera', () => {
  beforeEach(() => {
    workers.length = 0;
    vi.stubGlobal('Worker', class extends MockWorker {
      constructor() {
        super();
        workers.push(this);
      }
    });
    vi.mocked(createDetectionFrame).mockReset();
    vi.mocked(createDetectionFrame).mockReturnValue(undefined);
    vi.mocked(captureDocumentFrame).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'mediaDevices');
  });

  it.each(['error', 'messageerror'] as const)('stops failed detection after a worker %s and keeps manual capture available', async (failure) => {
    const owned = mediaStream();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'videoinput' }]),
        getUserMedia: vi.fn().mockResolvedValue(owned.stream),
      },
    });
    const { container } = render(<DocumentCamera active onCapture={vi.fn()} />);
    const video = screen.getByLabelText(i18n.t('documentScanner.cameraPreview'));
    await waitFor(() => expect(video).toHaveProperty('srcObject', owned.stream));
    fireEvent.loadedMetadata(video);
    await waitFor(() => expect(workers).toHaveLength(1));
    const worker = workers[0];
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'initialize' });
    initializeWorker(worker);
    act(() => worker.onmessage?.(new MessageEvent<DetectionResult>('message', { data: {
      confidence: 0.8,
      corners: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }],
      requestId: 1,
      status: 'ready',
    } })));
    expect(container.querySelector('polygon')).not.toBeNull();

    act(() => {
      if (failure === 'error') worker.onerror?.({ preventDefault: vi.fn() } as unknown as ErrorEvent);
      else worker.onmessageerror?.(new MessageEvent('messageerror'));
    });

    expect(await screen.findByText(i18n.t('documentScanner.detectionUnavailable'))).toBeInTheDocument();
    expect(container.querySelector('polygon')).toBeNull();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: i18n.t('documentScanner.capturePage') })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: i18n.t('documentScanner.autoCapture') })).toBeDisabled();
    const callsAfterFailure = vi.mocked(createDetectionFrame).mock.calls.length;
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    expect(createDetectionFrame).toHaveBeenCalledTimes(callsAfterFailure);
  });

  it('invalidates the previous stream before waiting for switched-camera metadata', async () => {
    const user = userEvent.setup();
    const first = mediaStream();
    const second = mediaStream();
    let resolveSecondStream: ((stream: MediaStream) => void) | undefined;
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce(first.stream)
      .mockImplementationOnce(() => new Promise<MediaStream>((resolve) => { resolveSecondStream = resolve; }));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'videoinput' }, { kind: 'videoinput' }]),
        getUserMedia,
      },
    });
    render(<DocumentCamera active onCapture={vi.fn()} />);
    const video = screen.getByLabelText(i18n.t('documentScanner.cameraPreview'));
    await waitFor(() => expect(video).toHaveProperty('srcObject', first.stream));
    fireEvent.loadedMetadata(video);
    const switchButton = await screen.findByRole('button', { name: i18n.t('documentScanner.switchCamera') });
    expect(switchButton).toHaveTextContent('');
    await waitFor(() => expect(workers).toHaveLength(1));
    initializeWorker(workers[0]);

    await user.click(switchButton);

    expect(first.stop).toHaveBeenCalled();
    expect(video).toHaveProperty('srcObject', null);
    expect(screen.getByRole('button', { name: i18n.t('documentScanner.capturePage') })).toBeDisabled();
    fireEvent.loadedMetadata(video);
    expect(screen.getByRole('button', { name: i18n.t('documentScanner.capturePage') })).toBeDisabled();
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);

    await act(async () => resolveSecondStream?.(second.stream));
    await waitFor(() => expect(video).toHaveProperty('srcObject', second.stream));
    expect(workers).toHaveLength(1);
    fireEvent.loadedMetadata(video);
    await waitFor(() => expect(workers).toHaveLength(2));
    expect(workers[1].postMessage).toHaveBeenCalledWith({ type: 'initialize' });
    expect(screen.getByRole('button', { name: i18n.t('documentScanner.capturePage') })).toBeEnabled();
    expect(screen.getByRole('button', { name: i18n.t('documentScanner.capturePage') })).toHaveTextContent('');
  });

  it('hides weak contours and excludes them from manual capture', async () => {
    const user = userEvent.setup();
    const owned = mediaStream();
    const capturedFile = new File(['jpeg'], 'page.jpg', { type: 'image/jpeg' });
    const onCapture = vi.fn();
    vi.mocked(captureDocumentFrame).mockResolvedValue(capturedFile);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'videoinput' }]),
        getUserMedia: vi.fn().mockResolvedValue(owned.stream),
      },
    });
    const { container } = render(<DocumentCamera active onCapture={onCapture} />);
    const video = screen.getByLabelText(i18n.t('documentScanner.cameraPreview'));
    await waitFor(() => expect(video).toHaveProperty('srcObject', owned.stream));
    fireEvent.loadedMetadata(video);
    await waitFor(() => expect(workers).toHaveLength(1));
    initializeWorker(workers[0]);

    act(() => workers[0].onmessage?.(new MessageEvent<DetectionResult>('message', { data: {
      confidence: 0.4,
      corners: [{ x: 0.01, y: 0.01 }, { x: 0.99, y: 0.01 }, { x: 0.99, y: 0.99 }, { x: 0.01, y: 0.99 }],
      requestId: 1,
      status: 'ready',
    } })));
    expect(container.querySelector('polygon')).toBeNull();

    await user.click(screen.getByRole('button', { name: i18n.t('documentScanner.capturePage') }));
    expect(onCapture).toHaveBeenCalledWith(capturedFile, DEFAULT_DOCUMENT_CORNERS);

    act(() => workers[0].onmessage?.(new MessageEvent<DetectionResult>('message', { data: {
      confidence: 0.9,
      corners: [{ x: 0.15, y: 0.12 }, { x: 0.85, y: 0.13 }, { x: 0.86, y: 0.88 }, { x: 0.14, y: 0.87 }],
      requestId: 2,
      status: 'ready',
    } })));
    expect(container.querySelector('polygon')).not.toBeNull();
  });

  it('contains the overlay in the rendered video frame instead of letterboxed space', async () => {
    const owned = mediaStream();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'videoinput' }]),
        getUserMedia: vi.fn().mockResolvedValue(owned.stream),
      },
    });
    render(<DocumentCamera active onCapture={vi.fn()} />);
    const video = screen.getByLabelText(i18n.t('documentScanner.cameraPreview'));
    await waitFor(() => expect(video).toHaveProperty('srcObject', owned.stream));
    Object.defineProperties(video, {
      videoHeight: { configurable: true, value: 1080 },
      videoWidth: { configurable: true, value: 1920 },
    });
    const preview = video.parentElement?.parentElement as HTMLDivElement;
    vi.spyOn(preview, 'getBoundingClientRect').mockReturnValue({
      bottom: 600,
      height: 600,
      left: 0,
      right: 300,
      top: 0,
      width: 300,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    });

    fireEvent.loadedMetadata(video);
    window.dispatchEvent(new Event('resize'));

    await waitFor(() => expect(video.parentElement).toHaveStyle({ height: '168.75px', width: '300px' }));
  });

  it('transfers bounded RGBA frames only after the detector reports ready', async () => {
    const owned = mediaStream();
    const frame = { data: new Uint8ClampedArray(8 * 8 * 4), height: 8, width: 8 } as ImageData;
    vi.mocked(createDetectionFrame).mockReturnValue(frame);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'videoinput' }]),
        getUserMedia: vi.fn().mockResolvedValue(owned.stream),
      },
    });
    render(<DocumentCamera active onCapture={vi.fn()} />);
    const video = screen.getByLabelText(i18n.t('documentScanner.cameraPreview'));
    await waitFor(() => expect(video).toHaveProperty('srcObject', owned.stream));
    fireEvent.loadedMetadata(video);
    await waitFor(() => expect(workers).toHaveLength(1));
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    expect(createDetectionFrame).not.toHaveBeenCalled();

    initializeWorker(workers[0]);

    await waitFor(() => expect(createDetectionFrame).toHaveBeenCalled(), { timeout: 1_000 });
    expect(workers[0].postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ imageData: frame, requestId: 1, type: 'detect' }),
      [frame.data.buffer],
    );
  });

  it('falls back to manual capture after repeated RGBA frame failures', async () => {
    const owned = mediaStream();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'videoinput' }]),
        getUserMedia: vi.fn().mockResolvedValue(owned.stream),
      },
    });
    render(<DocumentCamera active onCapture={vi.fn()} />);
    const video = screen.getByLabelText(i18n.t('documentScanner.cameraPreview'));
    await waitFor(() => expect(video).toHaveProperty('srcObject', owned.stream));
    fireEvent.loadedMetadata(video);
    await waitFor(() => expect(workers).toHaveLength(1));

    initializeWorker(workers[0]);

    await waitFor(() => expect(screen.getByText(i18n.t('documentScanner.detectionUnavailable'))).toBeInTheDocument(), { timeout: 1_600 });
    expect(createDetectionFrame).toHaveBeenCalledTimes(3);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: i18n.t('documentScanner.capturePage') })).toBeEnabled();
  });
});
