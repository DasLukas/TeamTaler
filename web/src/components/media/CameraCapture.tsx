import Camera from 'lucide-react/dist/esm/icons/camera';
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw';
import X from 'lucide-react/dist/esm/icons/x';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { captureVideoFrame } from './cameraCaptureUtils';
import styles from './CameraCapture.module.css';

type CameraStatus = 'starting' | 'ready' | 'error';
type CameraFacingMode = 'environment' | 'user';

/** Properties accepted by the live browser-camera capture surface. */
export interface CameraCaptureProps {
  /** Receives the metadata-free JPEG frame captured from the live preview. */
  onCapture: (file: File) => void;
  /** Closes the live camera without producing a file. */
  onCancel: () => void;
  /** Opens the platform file/camera chooser when live capture is unavailable. */
  onFallback: () => void;
}

/**
 * Stops every track owned by a camera stream.
 *
 * @param stream - Stream to release, or `undefined` before permission resolves.
 * @returns Nothing.
 */
function stopStream(stream?: MediaStream): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/**
 * Maps browser media failures to concise localized recovery guidance.
 *
 * @param error - Rejection reported by `getUserMedia`.
 * @returns Translation key for the matching user-facing camera error.
 */
function cameraErrorKey(error: unknown): string {
  const name = typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string'
    ? error.name
    : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'cameraCapture.permissionDenied';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'cameraCapture.notFound';
    case 'NotReadableError':
    case 'AbortError':
      return 'cameraCapture.inUse';
    default:
      return 'cameraCapture.unavailable';
  }
}

/**
 * Renders an accessible live camera preview with capture, camera switching,
 * cleanup, permission errors, and a native platform fallback.
 *
 * @param props - Capture, cancellation, and platform-fallback callbacks.
 * @returns A self-contained live camera capture surface.
 */
export function CameraCapture({ onCapture, onCancel, onFallback }: CameraCaptureProps) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [facingMode, setFacingMode] = useState<CameraFacingMode>('environment');
  const [status, setStatus] = useState<CameraStatus>('starting');
  const [errorKey, setErrorKey] = useState('');
  const [canSwitchCamera, setCanSwitchCamera] = useState(false);
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    let active = true;
    let stream: MediaStream | undefined;
    let attachedVideo: HTMLVideoElement | null = null;

    void navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: facingMode },
        height: { ideal: 1440 },
        width: { ideal: 1920 },
      },
    }).then(async (nextStream) => {
      stream = nextStream;
      if (!active) {
        stopStream(nextStream);
        return;
      }
      const video = videoRef.current;
      if (!video) {
        stopStream(nextStream);
        return;
      }
      attachedVideo = video;
      video.srcObject = nextStream;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (active) setCanSwitchCamera(devices.filter((device) => device.kind === 'videoinput').length > 1);
      } catch {
        if (active) setCanSwitchCamera(false);
      }
    }).catch((error: unknown) => {
      if (!active) return;
      setErrorKey(cameraErrorKey(error));
      setStatus('error');
    });

    return () => {
      active = false;
      stopStream(stream);
      if (attachedVideo) attachedVideo.srcObject = null;
    };
  }, [facingMode]);

  const capture = async () => {
    const video = videoRef.current;
    if (!video) return;
    setCapturing(true);
    try {
      onCapture(await captureVideoFrame(video));
    } catch {
      setErrorKey('cameraCapture.captureFailed');
      setStatus('error');
    } finally {
      setCapturing(false);
    }
  };

  return (
    <section aria-label={t('cameraCapture.title')} className={styles.capture}>
      <div className={styles.preview}>
        <video
          aria-label={t('cameraCapture.preview')}
          autoPlay
          muted
          onLoadedMetadata={() => setStatus('ready')}
          playsInline
          ref={videoRef}
        />
        {status === 'starting' ? <p role="status">{t('cameraCapture.starting')}</p> : null}
        {status === 'error' ? <p role="alert">{t(errorKey)}</p> : null}
      </div>
      <div className={styles.actions}>
        <Button leadingIcon={<X size={17} />} onClick={onCancel} size="small" variant="secondary">
          {t('common.cancel')}
        </Button>
        {status === 'error' ? (
          <Button leadingIcon={<Camera size={17} />} onClick={onFallback} size="small" variant="secondary">
            {t('cameraCapture.openDeviceDialog')}
          </Button>
        ) : null}
        {canSwitchCamera && status === 'ready' ? (
          <Button leadingIcon={<RefreshCw size={17} />} onClick={() => {
            setStatus('starting');
            setErrorKey('');
            setFacingMode((current) => current === 'environment' ? 'user' : 'environment');
          }} size="small" variant="secondary">
            {t('cameraCapture.switchCamera')}
          </Button>
        ) : null}
        <Button disabled={status !== 'ready' || capturing} leadingIcon={<Camera size={17} />} onClick={() => void capture()} size="small">
          {capturing ? t('cameraCapture.capturing') : t('cameraCapture.capture')}
        </Button>
      </div>
    </section>
  );
}
