import { useEffect, useState } from 'react';

interface QrCodeRenderOutcome {
  payload: string;
  dataUrl: string;
  error: Error | null;
}

/** State returned while a local QR image is generated for one exact payload. */
export interface QrCodeDataUrlState {
  dataUrl: string;
  error: Error | null;
  loading: boolean;
}

/**
 * Generates a local PNG QR image while keeping the QR dependency out of initial bundles.
 *
 * Results remain associated with their exact source payload, so an older asynchronous
 * render can never appear after the caller changes payment or invitation data.
 *
 * @param payload - UTF-8 content to encode, or an empty string to disable generation.
 * @returns Current data URL, loading state, and renderer error for the exact payload.
 */
export function useQrCodeDataUrl(payload: string): QrCodeDataUrlState {
  const [outcome, setOutcome] = useState<QrCodeRenderOutcome>({ payload: '', dataUrl: '', error: null });
  const matches = Boolean(payload) && outcome.payload === payload;

  useEffect(() => {
    if (!payload) return undefined;
    let cancelled = false;
    void import('qrcode')
      .then(({ toDataURL }) => toDataURL(payload, { errorCorrectionLevel: 'M', margin: 2, width: 320 }))
      .then((dataUrl) => {
        if (!cancelled) setOutcome({ payload, dataUrl, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setOutcome({ payload, dataUrl: '', error: error instanceof Error ? error : new Error(String(error)) });
      });
    return () => { cancelled = true; };
  }, [payload]);

  return {
    dataUrl: matches ? outcome.dataUrl : '',
    error: matches ? outcome.error : null,
    loading: Boolean(payload) && !matches,
  };
}
