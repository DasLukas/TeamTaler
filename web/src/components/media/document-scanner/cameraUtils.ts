/**
 * Reports whether secure live-camera capture can be requested.
 *
 * @returns `true` when the required browser API is available in a secure context.
 */
export function supportsDocumentCamera(): boolean {
  return globalThis.isSecureContext !== false && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

/**
 * Stops all tracks owned by a scanner camera stream.
 *
 * @param stream - Stream to stop, or `undefined` while a permission request is pending.
 * @returns Nothing.
 */
export function stopDocumentCamera(stream?: MediaStream): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/**
 * Captures a bounded, metadata-free JPEG from the active camera preview.
 *
 * @param video - Playing camera video element.
 * @param capturedAt - Timestamp used for deterministic file metadata.
 * @returns A JPEG page ready for the scanner editor.
 * @throws {Error} When no camera frame is ready or canvas encoding fails.
 */
export function captureDocumentFrame(video: HTMLVideoElement, capturedAt = Date.now()): Promise<File> {
  if (video.videoWidth <= 0 || video.videoHeight <= 0) return Promise.reject(new Error('No camera frame is available.'));
  const scale = Math.min(1, 2200 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) return Promise.reject(new Error('Canvas rendering is unavailable.'));
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('The camera frame could not be encoded.'));
        return;
      }
      resolve(new File([blob], `document-page-${capturedAt}.jpg`, { lastModified: capturedAt, type: 'image/jpeg' }));
    }, 'image/jpeg', 0.9);
  });
}

/**
 * Creates a small transferable bitmap for background edge detection.
 *
 * @param video - Playing camera preview.
 * @returns A bitmap whose longest edge is at most 720 pixels, or `undefined` before video readiness.
 * @throws {Error} When the browser cannot create a bitmap from the canvas.
 */
export async function createDetectionBitmap(video: HTMLVideoElement): Promise<ImageBitmap | undefined> {
  if (video.videoWidth <= 0 || video.videoHeight <= 0) return undefined;
  const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return createImageBitmap(canvas);
}
