const MEBIBYTE = 1024 * 1024;

/** Absolute upper bound for compressed images retained by one scanner session. */
export const MAX_SCANNER_SOURCE_BYTES = 128 * MEBIBYTE;

/** Upper bound for the combined source-image pixels accepted by one scan. */
export const MAX_SCANNER_SOURCE_PIXELS = 160_000_000;

/** Upper bound for pixels rendered and embedded into one generated PDF. */
export const MAX_SCANNER_RENDERED_PIXELS = 120_000_000;

/**
 * Derives a bounded source-file budget from the configured final upload limit.
 *
 * @param maxBytes - Configured maximum size of the generated PDF.
 * @returns The maximum combined size of compressed source images.
 * @throws {Error} When the configured upload limit is not positive and finite.
 */
export function scannerSourceByteBudget(maxBytes: number): number {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('The PDF size limit must be positive.');
  return Math.min(MAX_SCANNER_SOURCE_BYTES, maxBytes * 4);
}
