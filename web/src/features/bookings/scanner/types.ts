import type { ProductBarcodeFormat } from '@/api/types';

/** Supported scanner result, independent of the decoding library. */
export interface ScannedCode {
  /** Decoded payload; never navigated to or executed by the camera layer. */
  value: string;
  /** Format used by the catalog and booking resolver. */
  format: ProductBarcodeFormat | 'QR_CODE';
}

/** Pixel rectangle in a camera frame or browser viewport. */
export interface ScanRectangle { x: number; y: number; width: number; height: number }

/** Bounded, transferable input for the private barcode worker. */
export type BarcodeWorkerRequest = { type: 'initialize' } | {
  type: 'decode'; id: number; width: number; height: number; pixels: ArrayBuffer; barcodeOnly: boolean;
};

/** Worker readiness, a decoded frame, or an unrecoverable decoder error. */
export type BarcodeWorkerResponse = { type: 'ready' } | { type: 'result'; id: number; codes: ScannedCode[] } | { type: 'error' };
