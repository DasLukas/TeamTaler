import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { createDetectionBitmap } from './cameraUtils';
import { DocumentCamera } from './DocumentCamera';
import type { DetectionResult } from './types';

vi.mock('./cameraUtils', () => ({
  captureDocumentFrame: vi.fn(),
  createDetectionBitmap: vi.fn(),
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

describe('DocumentCamera', () => {
  beforeEach(() => {
    workers.length = 0;
    vi.stubGlobal('Worker', class extends MockWorker {
      constructor() {
        super();
        workers.push(this);
      }
    });
    vi.mocked(createDetectionBitmap).mockReset();
    vi.mocked(createDetectionBitmap).mockResolvedValue(undefined);
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
    act(() => worker.onmessage?.(new MessageEvent<DetectionResult>('message', { data: {
      confidence: 0.8,
      corners: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }],
      requestId: 1,
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
    const callsAfterFailure = vi.mocked(createDetectionBitmap).mock.calls.length;
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    expect(createDetectionBitmap).toHaveBeenCalledTimes(callsAfterFailure);
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
    expect(screen.getByRole('button', { name: i18n.t('documentScanner.capturePage') })).toBeEnabled();
    expect(screen.getByRole('button', { name: i18n.t('documentScanner.capturePage') })).toHaveTextContent('');
  });
});
