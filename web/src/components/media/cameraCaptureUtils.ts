/**
 * Reports whether the current browser exposes secure live camera access.
 *
 * @returns `true` when `getUserMedia` can be requested, otherwise `false`.
 *
 * @example
 * `if (supportsLiveCamera()) setCameraOpen(true)`
 */
export function supportsLiveCamera(): boolean {
  return globalThis.isSecureContext !== false && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

/**
 * Converts the current browser video frame into an uploadable JPEG file.
 * Large sensor frames are bounded to 2048 pixels on their longest edge to
 * avoid excessive mobile memory use before the shared square crop runs.
 *
 * @param video - Playing video element backed by a camera stream.
 * @param capturedAt - Timestamp used for the deterministic file name and metadata.
 * @returns A metadata-free JPEG file containing the visible camera frame.
 * @throws {Error} When no frame is ready or canvas encoding is unavailable.
 *
 * @example
 * `const file = await captureVideoFrame(videoElement)`
 */
export function captureVideoFrame(video: HTMLVideoElement, capturedAt = Date.now()): Promise<File> {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return Promise.reject(new Error('No camera frame is available.'));
  }

  const scale = Math.min(1, 2048 / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sourceWidth * scale);
  canvas.height = Math.round(sourceHeight * scale);
  const context = canvas.getContext('2d');
  if (!context) return Promise.reject(new Error('Canvas rendering is unavailable.'));
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('The camera frame could not be encoded.'));
        return;
      }
      resolve(new File([blob], `product-camera-${capturedAt}.jpg`, {
        type: 'image/jpeg',
        lastModified: capturedAt,
      }));
    }, 'image/jpeg', 0.92);
  });
}
