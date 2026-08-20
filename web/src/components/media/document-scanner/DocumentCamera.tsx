import Camera from 'lucide-react/dist/esm/icons/camera';
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '@/components/ui/IconButton';
import { captureDocumentFrame, createDetectionBitmap, stopDocumentCamera, supportsDocumentCamera } from './cameraUtils';
import type { DetectionRequest, DetectionResult, DocumentCorners } from './types';
import styles from './DocumentScannerWorkspace.module.css';

interface DocumentCameraProps {
  active: boolean;
  onCapture: (file: File, corners: DocumentCorners) => void;
}

function cornersAreStable(first: DocumentCorners, second: DocumentCorners): boolean {
  return first.every((point, index) => Math.hypot(point.x - second[index].x, point.y - second[index].y) < 0.035);
}

/**
 * Renders the scanner-owned camera preview and background document detection.
 *
 * @param props - Activity state plus capture and native-fallback callbacks.
 * @returns A camera surface whose stream and worker are scoped to its active lifetime.
 */
export function DocumentCamera({ active, onCapture }: DocumentCameraProps) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const activeStreamRef = useRef<MediaStream | undefined>(undefined);
  const workerRef = useRef<Worker | undefined>(undefined);
  const detectionPendingRef = useRef(false);
  const requestIdRef = useRef(0);
  const stableDetectionRef = useRef<{ count: number; corners: DocumentCorners } | undefined>(undefined);
  const detectedCornersRef = useRef<DocumentCorners | undefined>(undefined);
  const lastCapturedCornersRef = useRef<DocumentCorners | undefined>(undefined);
  const automaticCaptureArmedRef = useRef(true);
  const autoCaptureRef = useRef(true);
  const lastAutomaticCaptureRef = useRef(0);
  const captureInProgressRef = useRef(false);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [status, setStatus] = useState<'starting' | 'ready' | 'error'>(supportsDocumentCamera() ? 'starting' : 'error');
  const [canSwitchCamera, setCanSwitchCamera] = useState(false);
  const [detectedCorners, setDetectedCorners] = useState<DocumentCorners>();
  const [autoCapture, setAutoCapture] = useState(true);
  const [detectionAvailable, setDetectionAvailable] = useState(typeof Worker !== 'undefined');

  const clearDetectionRefs = useCallback(() => {
    detectionPendingRef.current = false;
    stableDetectionRef.current = undefined;
    detectedCornersRef.current = undefined;
    lastCapturedCornersRef.current = undefined;
    automaticCaptureArmedRef.current = true;
  }, []);

  const resetDetectionState = useCallback(() => {
    clearDetectionRefs();
    setDetectedCorners(undefined);
  }, [clearDetectionRefs]);

  const capture = useCallback(async (automatic = false) => {
    const video = videoRef.current;
    if (!video || captureInProgressRef.current) return;
    captureInProgressRef.current = true;
    try {
      const file = await captureDocumentFrame(video);
      const corners = detectedCornersRef.current ?? [{ x: 0.04, y: 0.04 }, { x: 0.96, y: 0.04 }, { x: 0.96, y: 0.96 }, { x: 0.04, y: 0.96 }];
      onCapture(file, corners);
      lastCapturedCornersRef.current = corners;
      automaticCaptureArmedRef.current = false;
      if (automatic) lastAutomaticCaptureRef.current = performance.now();
    } catch {
      setStatus('error');
    } finally {
      captureInProgressRef.current = false;
    }
  }, [onCapture]);

  useEffect(() => {
    if (!active || !supportsDocumentCamera()) return undefined;
    let current = true;
    let stream: MediaStream | undefined;
    let attachedVideo: HTMLVideoElement | null = null;
    clearDetectionRefs();
    const startingTimer = window.setTimeout(() => {
      if (!current) return;
      resetDetectionState();
      setDetectionAvailable(typeof Worker !== 'undefined');
      setStatus('starting');
    }, 0);
    void navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facingMode }, height: { ideal: 1920 }, width: { ideal: 2560 } },
    }).then(async (nextStream) => {
      stream = nextStream;
      if (!current || !videoRef.current) {
        stopDocumentCamera(nextStream);
        return;
      }
      window.clearTimeout(startingTimer);
      resetDetectionState();
      setDetectionAvailable(typeof Worker !== 'undefined');
      setStatus('starting');
      attachedVideo = videoRef.current;
      activeStreamRef.current = nextStream;
      attachedVideo.srcObject = nextStream;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (current) setCanSwitchCamera(devices.filter((device) => device.kind === 'videoinput').length > 1);
      } catch {
        if (current) setCanSwitchCamera(false);
      }
    }).catch(() => {
      if (current) {
        window.clearTimeout(startingTimer);
        activeStreamRef.current = undefined;
        setStatus('error');
      }
    });
    return () => {
      current = false;
      window.clearTimeout(startingTimer);
      stopDocumentCamera(stream);
      if (attachedVideo) attachedVideo.srcObject = null;
      if (activeStreamRef.current === stream) activeStreamRef.current = undefined;
    };
  }, [active, clearDetectionRefs, facingMode, resetDetectionState]);

  useEffect(() => {
    if (!active || status !== 'ready' || !activeStreamRef.current
      || videoRef.current?.srcObject !== activeStreamRef.current || typeof Worker === 'undefined') return undefined;
    let worker: Worker;
    try {
      worker = new Worker(new URL('./documentDetection.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      const fallbackTimer = window.setTimeout(() => {
        resetDetectionState();
        setDetectionAvailable(false);
      }, 0);
      return () => window.clearTimeout(fallbackTimer);
    }
    let disposed = false;
    workerRef.current = worker;
    const stopDetection = (showFallback: boolean) => {
      if (disposed) return;
      disposed = true;
      window.clearInterval(interval);
      worker.onerror = null;
      worker.onmessage = null;
      worker.onmessageerror = null;
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = undefined;
      detectionPendingRef.current = false;
      stableDetectionRef.current = undefined;
      detectedCornersRef.current = undefined;
      if (showFallback) {
        resetDetectionState();
        setDetectionAvailable(false);
      }
    };
    worker.onmessage = (event: MessageEvent<DetectionResult>) => {
      if (disposed) return;
      detectionPendingRef.current = false;
      const result = event.data;
      detectedCornersRef.current = result.corners;
      setDetectedCorners(result.corners);
      if (result.confidence < 0.45) {
        automaticCaptureArmedRef.current = true;
        lastCapturedCornersRef.current = undefined;
      }
      if (!autoCaptureRef.current || result.confidence < 0.72) {
        stableDetectionRef.current = undefined;
        return;
      }
      const lastCaptured = lastCapturedCornersRef.current;
      if (lastCaptured && !cornersAreStable(lastCaptured, result.corners)) {
        automaticCaptureArmedRef.current = true;
        lastCapturedCornersRef.current = undefined;
      }
      const previous = stableDetectionRef.current;
      const count = previous && cornersAreStable(previous.corners, result.corners) ? previous.count + 1 : 1;
      stableDetectionRef.current = { corners: result.corners, count };
      if (count >= 3 && automaticCaptureArmedRef.current && performance.now() - lastAutomaticCaptureRef.current > 2200) {
        stableDetectionRef.current = undefined;
        void capture(true);
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      stopDetection(true);
    };
    worker.onmessageerror = () => stopDetection(true);
    const interval = window.setInterval(() => {
      const video = videoRef.current;
      if (disposed || !video || detectionPendingRef.current) return;
      detectionPendingRef.current = true;
      void createDetectionBitmap(video).then((bitmap) => {
        if (!bitmap || disposed || workerRef.current !== worker) {
          bitmap?.close();
          detectionPendingRef.current = false;
          return;
        }
        const request: DetectionRequest = { bitmap, requestId: ++requestIdRef.current, type: 'detect' };
        try {
          worker.postMessage(request, [bitmap]);
        } catch {
          bitmap.close();
          detectionPendingRef.current = false;
        }
      }, () => { detectionPendingRef.current = false; });
    }, 450);
    return () => {
      stopDetection(false);
    };
  }, [active, capture, resetDetectionState, status]);

  const switchCamera = () => {
    const previousStream = activeStreamRef.current;
    activeStreamRef.current = undefined;
    if (videoRef.current) videoRef.current.srcObject = null;
    stopDocumentCamera(previousStream);
    setStatus('starting');
    setDetectionAvailable(typeof Worker !== 'undefined');
    resetDetectionState();
    setFacingMode((current) => current === 'environment' ? 'user' : 'environment');
  };

  const cameraReady = active && status === 'ready';

  return (
    <section aria-label={t('documentScanner.cameraTitle', { defaultValue: 'Document camera' })} className={styles.cameraPanel}>
      <div className={styles.cameraPreview}>
        <video
          aria-label={t('documentScanner.cameraPreview', { defaultValue: 'Live document preview' })}
          autoPlay
          muted
          onLoadedMetadata={(event) => {
            if (active && event.currentTarget.srcObject === activeStreamRef.current) setStatus('ready');
          }}
          playsInline
          ref={videoRef}
        />
        {detectedCorners && cameraReady ? (
          <svg aria-hidden="true" className={styles.detectionOverlay} preserveAspectRatio="none" viewBox="0 0 100 100">
            <polygon points={detectedCorners.map((point) => `${point.x * 100},${point.y * 100}`).join(' ')} />
          </svg>
        ) : null}
        {status === 'starting' ? <p role="status">{t('documentScanner.cameraStarting', { defaultValue: 'Starting camera…' })}</p> : null}
        {status === 'error' ? (
          <div className={styles.cameraError} role="alert">
            <p>{t('documentScanner.cameraUnavailable', { defaultValue: 'The live camera is unavailable. Cancel the scan and choose the photo library or a file from the receipt field.' })}</p>
          </div>
        ) : null}
        <div className={styles.cameraControls}>
          <label className={styles.autoCaptureToggle}>
            <input checked={autoCapture} disabled={!detectionAvailable} onChange={(event) => { autoCaptureRef.current = event.target.checked; setAutoCapture(event.target.checked); }} type="checkbox" />
            <span>{t('documentScanner.autoCapture', { defaultValue: 'Auto' })}</span>
          </label>
          {!detectionAvailable && cameraReady ? (
            <p className={styles.detectionWarning} role="status">
              {t('documentScanner.detectionUnavailable', { defaultValue: 'Automatic document detection is unavailable. Capture the page manually.' })}
            </p>
          ) : null}
          {canSwitchCamera && cameraReady ? (
            <IconButton className={styles.switchCameraControl} label={t('documentScanner.switchCamera', { defaultValue: 'Switch camera' })} onClick={switchCamera} variant="dark">
              <RefreshCw aria-hidden="true" size={22} />
            </IconButton>
          ) : null}
          <IconButton className={styles.captureControl} disabled={!cameraReady} label={t('documentScanner.capturePage', { defaultValue: 'Capture page' })} onClick={() => void capture()} variant="dark">
            <Camera aria-hidden="true" size={28} />
          </IconButton>
        </div>
      </div>
    </section>
  );
}
