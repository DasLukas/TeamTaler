import { prepareZXingModule, readBarcodes, type ReadInputBarcodeFormat } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import { barcodeKey } from '../kioskScan';
import { rotateFrame } from './rotateFrame';
import type { ScannedCode } from './types';

const linearFormats: ReadInputBarcodeFormat[] = ['EAN8', 'EAN13', 'UPCA', 'UPCE', 'Code128'];
const formatNames: Record<string, ScannedCode['format']> = { EAN8: 'EAN_8', EAN13: 'EAN_13', UPCA: 'UPC_A', UPCE: 'UPC_E', Code128: 'CODE_128', QRCode: 'QR_CODE', QRCodeModel1: 'QR_CODE', QRCodeModel2: 'QR_CODE' };
let initialization: Promise<unknown> | undefined;

/**
 * Initializes the locally bundled decoder once, without a CDN or fallback network origin.
 * @returns Decoder readiness; failures reject and are surfaced by the camera UI.
 * @throws {Error} If the local WASM asset cannot be fetched or initialized.
 */
export function initializeBarcodeDecoder(): Promise<unknown> {
  initialization ??= prepareZXingModule({ overrides: { locateFile: () => wasmUrl }, fireImmediately: true });
  return initialization;
}

/**
 * Decodes only the caller's cropped pixels, including arbitrarily oriented linear symbols.
 * @param frame - RGBA scan-area pixels, at most 720 pixels per side.
 * @param barcodeOnly - Whether QR codes must be excluded for catalog capture.
 * @returns Up to four valid supported codes; callers reject ambiguous multi-code frames.
 * @throws {Error} On decoder initialization or execution failure.
 */
export async function decodeBarcodeFrame(frame: ImageData, barcodeOnly = false): Promise<ScannedCode[]> {
  await initializeBarcodeDecoder();
  const found = new Map<string, ScannedCode[]>();
  // ZXing covers quarter turns; bounded intermediate views cover diagonal scan lines.
  // Continue after a single hit so another differently oriented code is not selected accidentally.
  for (const angle of [0, 15, 30, 45, 60, 75]) {
    const results = await readBarcodes(angle ? rotateFrame(frame, angle) : frame, {
      formats: angle || barcodeOnly ? linearFormats : [...linearFormats, 'QRCode'],
      tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: false, minLineCount: 2,
      maxNumberOfSymbols: 4, returnErrors: false, textMode: 'Plain',
    });
    const observed = new Map<string, ScannedCode[]>();
    for (const result of results) {
      let format = formatNames[result.format];
      if (!format || !result.isValid) continue;
      let value = result.text;
      if (format === 'UPC_E') {
        const original: unknown = JSON.parse(result.extra || '{}').UPCE;
        if (typeof original === 'string' && /^[01]\d{7}$/.test(original)) value = original;
        else if (/^0\d{12}$/.test(value)) format = 'EAN_13';
        else continue;
      }
      const key = format === 'QR_CODE' ? `QR:${value}` : barcodeKey(format, value);
      if (!key) continue;
      const matches = observed.get(key) ?? [];
      matches.push({ value, format });
      observed.set(key, matches);
    }
    for (const [key, matches] of observed) if (matches.length > (found.get(key)?.length ?? 0)) found.set(key, matches);
    if ([...found.values()].flat().length > 1) break;
  }
  return [...found.values()].flat().slice(0, 4);
}
