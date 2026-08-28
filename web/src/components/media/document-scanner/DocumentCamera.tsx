import Camera from 'lucide-react/dist/esm/icons/camera';
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '@/components/ui/IconButton';
import { captureDocumentFrame, createDetectionFrame, stopDocumentCamera, supportsDocumentCamera } from './cameraUtils';
import {
  DOCUMENT_CAPTURE_CONFIDENCE,
  DOCUMENT_DETECTION_MAX_AGE_MS,
  DOCUMENT_DISPLAY_CONFIDENCE,
  DOCUMENT_REARM_DISTANCE,
  DOCUMENT_STABLE_DISTANCE,
  maximumCornerDistance,
  smoothDocumentCorners,
} from './documentDetection';
import { containedAspectSize, DEFAULT_DOCUMENT_CORNERS } from './geometry';
import type { DetectionRequest, DetectionResult, DocumentCorners } from './types';
import styles from './DocumentScannerWorkspace.module.css';

interface DocumentCameraProps {
  active: boolean;
  onCapture: (file: File, corners: DocumentCorners) => void;
}

interface AcceptedDetection {
  confidence: number;
  corners: DocumentCorners;
  detectedAt: number;
}

interface FrameSize {
  height: number;
  width: number;
}

const AUTO_CAPTURE_STABLE_FRAMES = 4;
const DETECTION_MISSES_BEFORE_CLEAR = 3;
const DETECTION_INITIALIZATION_TIMEOUT_MS = 20_000;
const DETECTION_FRAME_FAILURE_LIMIT = 3;

/**
 * Renders the scanner-owned camera preview and background document detection.
 *
 * @param props - Activity state plus capture callback.
 * @returns A camera surface whose stream and worker are scoped to its active lifetime.
 */
export function DocumentCamera({ active, onCapture }: DocumentCameraProps) {
  const { t } = useTranslation();
  const previewRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const activeStreamRef = useRef<MediaStream | undefined>(undefined);
  const workerRef = useRef<Worker | undefined>(undefined);
  const detectionPendingRef = useRef(false);
  const requestIdRef = useRef(0);
  const stableDetectionRef = useRef<{ count: number; corners: DocumentCorners } | undefined>(undefined);
  const acceptedDetectionRef = useRef<AcceptedDetection | undefined>(undefined);
  const displayedCornersRef = useRef<DocumentCorners | undefined>(undefined);
  const missedDetectionsRef = useRef(0);
  const lastCapturedCornersRef = useRef<DocumentCorners | undefined>(undefined);
  const automaticCaptureArmedRef = useRef(true);
  const autoCaptureRef = useRef(true);
  const lastAutomaticCaptureRef = useRef(0);
  const captureInProgressRef = useRef(false);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [status, setStatus] = useState<'starting' | 'ready' | 'error'>(supportsDocumentCamera() ? 'starting' : 'error');
  const [detectionStatus, setDetectionStatus] = useState<'loading' | 'ready' | 'unavailable'>(typeof Worker === 'undefined' ? 'unavailable' : 'loading');
  const [canSwitchCamera, setCanSwitchCamera] = useState(false);
  const [detectedCorners, setDetectedCorners] = useState<DocumentCorners>();
  const [autoCapture, setAutoCapture] = useState(true);
  const [videoAspect, setVideoAspect] = useState<number>();
  const [cameraFrameSize, setCameraFrameSize] = useState<FrameSize>();

  const clearDetectionRefs = useCallback(() => {
    detectionPendingRef.current = false;
    stableDetectionRef.current = undefined;
    acceptedDetectionRef.current = undefined;
    displayedCornersRef.current = undefined;
    missedDetectionsRef.current = 0;
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
      const detection = acceptedDetectionRef.current;
      const corners = detection && performance.now() - detection.detectedAt <= DOCUMENT_DETECTION_MAX_AGE_MS
        ? detection.corners
        : DEFAULT_DOCUMENT_CORNERS;
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

  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (!preview || !videoAspect) {
      setCameraFrameSize(undefined);
      return undefined;
    }
    const synchronize = () => {
      const bounds = preview.getBoundingClientRect();
      const next = containedAspectSize(bounds.width, bounds.height, videoAspect);
      setCameraFrameSize((current) => {
        if (!next || (current && Math.abs(current.height - next.height) < 0.5 && Math.abs(current.width - next.width) < 0.5)) return current;
        return next;
      });
    };
    synchronize();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', synchronize);
      return () => window.removeEventListener('resize', synchronize);
    }
    const observer = new ResizeObserver(synchronize);
    observer.observe(preview);
    return () => observer.disconnect();
  }, [videoAspect]);

  useEffect(() => {
    if (!active || !supportsDocumentCamera()) return undefined;
    let current = true;
    let stream: MediaStream | undefined;
    let attachedVideo: HTMLVideoElement | null = null;
    clearDetectionRefs();
    const startingTimer = window.setTimeout(() => {
      if (!current) return;
      resetDetectionState();
      setDetectionStatus(typeof Worker === 'undefined' ? 'unavailable' : 'loading');
      setStatus('starting');
      setVideoAspect(undefined);
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
      setDetectionStatus(typeof Worker === 'undefined' ? 'unavailable' : 'loading');
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
        setDetectionStatus('unavailable');
      }, 0);
      return () => window.clearTimeout(fallbackTimer);
    }
    let disposed = false;
    let initialized = false;
    let frameFailures = 0;
    workerRef.current = worker;
    const stopDetection = (showFallback: boolean) => {
      if (disposed) return;
      disposed = true;
      window.clearTimeout(initializationTimer);
      window.clearInterval(interval);
      worker.onerror = null;
      worker.onmessage = null;
      worker.onmessageerror = null;
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = undefined;
      detectionPendingRef.current = false;
      stableDetectionRef.current = undefined;
      acceptedDetectionRef.current = undefined;
      displayedCornersRef.current = undefined;
      if (showFallback) {
        resetDetectionState();
        setDetectionStatus('unavailable');
      }
    };
    const initializationTimer = window.setTimeout(() => stopDetection(true), DETECTION_INITIALIZATION_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<DetectionResult>) => {
      if (disposed) return;
      const result = event.data;
      if (result.requestId === 0) {
        if (result.status === 'unavailable') {
          stopDetection(true);
          return;
        }
        initialized = true;
        window.clearTimeout(initializationTimer);
        setDetectionStatus('ready');
        return;
      }
      detectionPendingRef.current = false;
      if (result.status === 'unavailable') {
        stopDetection(true);
        return;
      }
      frameFailures = 0;
      if (!result.corners || result.confidence < DOCUMENT_DISPLAY_CONFIDENCE) {
        missedDetectionsRef.current += 1;
        stableDetectionRef.current = undefined;
        if (missedDetectionsRef.current >= DETECTION_MISSES_BEFORE_CLEAR) {
          acceptedDetectionRef.current = undefined;
          displayedCornersRef.current = undefined;
          setDetectedCorners(undefined);
          automaticCaptureArmedRef.current = true;
          lastCapturedCornersRef.current = undefined;
        }
        return;
      }

      missedDetectionsRef.current = 0;
      const previousDisplayed = displayedCornersRef.current;
      const smoothed = previousDisplayed ? smoothDocumentCorners(previousDisplayed, result.corners) : result.corners;
      displayedCornersRef.current = smoothed;
      acceptedDetectionRef.current = { confidence: result.confidence, corners: smoothed, detectedAt: performance.now() };
      setDetectedCorners(smoothed);

      const lastCaptured = lastCapturedCornersRef.current;
      if (lastCaptured && maximumCornerDistance(lastCaptured, smoothed) > DOCUMENT_REARM_DISTANCE) {
        automaticCaptureArmedRef.current = true;
        lastCapturedCornersRef.current = undefined;
      }
      if (!autoCaptureRef.current || result.confidence < DOCUMENT_CAPTURE_CONFIDENCE) {
        stableDetectionRef.current = undefined;
        return;
      }
      const previousStable = stableDetectionRef.current;
      const count = previousStable && maximumCornerDistance(previousStable.corners, smoothed) < DOCUMENT_STABLE_DISTANCE
        ? previousStable.count + 1
        : 1;
      stableDetectionRef.current = { corners: smoothed, count };
      if (count >= AUTO_CAPTURE_STABLE_FRAMES && automaticCaptureArmedRef.current && performance.now() - lastAutomaticCaptureRef.current > 2_200) {
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
      if (disposed || !initialized || !video || detectionPendingRef.current) return;
      detectionPendingRef.current = true;
      try {
        const imageData = createDetectionFrame(video);
        if (disposed || workerRef.current !== worker) {
          detectionPendingRef.current = false;
          return;
        }
        if (!imageData) {
          detectionPendingRef.current = false;
          frameFailures += 1;
          if (frameFailures >= DETECTION_FRAME_FAILURE_LIMIT) stopDetection(true);
          return;
        }
        const request: DetectionRequest = { imageData, requestId: ++requestIdRef.current, type: 'detect' };
        try {
          worker.postMessage(request, [imageData.data.buffer as ArrayBuffer]);
        } catch {
          try {
            worker.postMessage(request);
          } catch {
            detectionPendingRef.current = false;
            frameFailures += 1;
            if (frameFailures >= DETECTION_FRAME_FAILURE_LIMIT) stopDetection(true);
          }
        }
      } catch {
        detectionPendingRef.current = false;
        frameFailures += 1;
        if (frameFailures >= DETECTION_FRAME_FAILURE_LIMIT) stopDetection(true);
      }
    }, 360);
    try {
      worker.postMessage({ type: 'initialize' });
    } catch {
      stopDetection(true);
    }
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
    setDetectionStatus(typeof Worker === 'undefined' ? 'unavailable' : 'loading');
    setVideoAspect(undefined);
    resetDetectionState();
    setFacingMode((current) => current === 'environment' ? 'user' : 'environment');
  };

  const synchronizeVideoAspect = (video: HTMLVideoElement) => {
    if (video.videoWidth > 0 && video.videoHeight > 0) setVideoAspect(video.videoWidth / video.videoHeight);
  };
  const cameraReady = active && status === 'ready';

  return (
    <section aria-label={t('documentScanner.cameraTitle', { defaultValue: 'Document camera' })} className={styles.cameraPanel}>
      <div className={styles.cameraPreview} ref={previewRef}>
        <div className={styles.cameraMedia} style={{ height: cameraFrameSize?.height, width: cameraFrameSize?.width }}>
          <video
            aria-label={t('documentScanner.cameraPreview', { defaultValue: 'Live document preview' })}
            autoPlay
            muted
            onLoadedMetadata={(event) => {
              synchronizeVideoAspect(event.currentTarget);
              if (active && event.currentTarget.srcObject === activeStreamRef.current) setStatus('ready');
            }}
            onResize={(event) => synchronizeVideoAspect(event.currentTarget)}
            playsInline
            ref={videoRef}
          />
          {detectedCorners && cameraReady ? (
            <svg aria-hidden="true" className={styles.detectionOverlay} preserveAspectRatio="none" viewBox="0 0 100 100">
              <polygon points={detectedCorners.map((point) => `${point.x * 100},${point.y * 100}`).join(' ')} />
            </svg>
          ) : null}
        </div>
        {status === 'starting' ? <p role="status">{t('documentScanner.cameraStarting', { defaultValue: 'Starting camera…' })}</p> : null}
        {status === 'error' ? (
          <div className={styles.cameraError} role="alert">
            <p>{t('documentScanner.cameraUnavailable', { defaultValue: 'The live camera is unavailable. Cancel the scan and choose the photo library or a file from the receipt field.' })}</p>
          </div>
        ) : null}
        <div className={styles.cameraControls}>
          <label className={styles.autoCaptureToggle}>
            <input checked={autoCapture} disabled={detectionStatus === 'unavailable'} onChange={(event) => { autoCaptureRef.current = event.target.checked; setAutoCapture(event.target.checked); }} type="checkbox" />
            <span>{t('documentScanner.autoCapture', { defaultValue: 'Auto' })}</span>
          </label>
          {detectionStatus === 'loading' && cameraReady ? (
            <p className={styles.detectionWarning} role="status">
              {t('documentScanner.detectionPreparing', { defaultValue: 'Preparing automatic document detection…' })}
            </p>
          ) : null}
          {detectionStatus === 'unavailable' && cameraReady ? (
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
