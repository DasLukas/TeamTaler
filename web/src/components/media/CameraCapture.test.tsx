import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { CameraCapture } from './CameraCapture';
import { captureVideoFrame, supportsLiveCamera } from './cameraCaptureUtils';

function installMediaDevices(getUserMedia: ReturnType<typeof vi.fn>, enumerateDevices = vi.fn().mockResolvedValue([])): void {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { enumerateDevices, getUserMedia },
  });
  Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true });
}

function mediaStream(stop = vi.fn()): MediaStream {
  return { getTracks: () => [{ stop }] } as unknown as MediaStream;
}

describe('CameraCapture', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'mediaDevices');
    Reflect.deleteProperty(globalThis, 'isSecureContext');
  });

  it('detects secure live-camera support', () => {
    installMediaDevices(vi.fn());
    expect(supportsLiveCamera()).toBe(true);

    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: false });
    expect(supportsLiveCamera()).toBe(false);
  });

  it('prefers the rear camera and stops its stream when closed', async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue(mediaStream(stop));
    installMediaDevices(getUserMedia);
    const { unmount } = render(<CameraCapture onCancel={vi.fn()} onCapture={vi.fn()} onFallback={vi.fn()} />);

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        height: { ideal: 1440 },
        width: { ideal: 1920 },
      },
    }));
    fireEvent.loadedMetadata(screen.getByLabelText(i18n.t('cameraCapture.preview')));
    expect(screen.getByRole('button', { name: i18n.t('cameraCapture.capture') })).toBeEnabled();

    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('captures a bounded JPEG frame and returns it to the caller', async () => {
    const video = document.createElement('video');
    Object.defineProperties(video, {
      videoHeight: { configurable: true, value: 3000 },
      videoWidth: { configurable: true, value: 4000 },
    });
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob(['jpeg'], { type: 'image/jpeg' }));
    });

    const file = await captureVideoFrame(video, 12345);

    expect(file.name).toBe('product-camera-12345.jpg');
    expect(file.type).toBe('image/jpeg');
    expect(file.lastModified).toBe(12345);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.92);
  });

  it('offers the native device dialog after camera permission is denied', async () => {
    const user = userEvent.setup();
    const onFallback = vi.fn();
    installMediaDevices(vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError')));
    render(<CameraCapture onCancel={vi.fn()} onCapture={vi.fn()} onFallback={onFallback} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('cameraCapture.permissionDenied'));
    await user.click(screen.getByRole('button', { name: i18n.t('cameraCapture.openDeviceDialog') }));

    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('switches between rear and front cameras when multiple inputs exist', async () => {
    const user = userEvent.setup();
    const firstStop = vi.fn();
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce(mediaStream(firstStop))
      .mockResolvedValueOnce(mediaStream());
    installMediaDevices(getUserMedia, vi.fn().mockResolvedValue([
      { kind: 'videoinput' },
      { kind: 'videoinput' },
    ]));
    render(<CameraCapture onCancel={vi.fn()} onCapture={vi.fn()} onFallback={vi.fn()} />);

    fireEvent.loadedMetadata(await screen.findByLabelText(i18n.t('cameraCapture.preview')));
    await user.click(await screen.findByRole('button', { name: i18n.t('cameraCapture.switchCamera') }));

    await waitFor(() => expect(getUserMedia).toHaveBeenNthCalledWith(2, expect.objectContaining({
      video: expect.objectContaining({ facingMode: { ideal: 'user' } }),
    })));
    expect(firstStop).toHaveBeenCalledTimes(1);
  });
});
