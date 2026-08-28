/**
 * Starts a browser download for an already generated data URL.
 *
 * @param dataUrl - Complete browser-safe data URL.
 * @param fileName - Trusted local filename including its extension.
 * @returns Nothing.
 */
export function downloadDataUrl(dataUrl: string, fileName: string): void {
  const anchor = document.createElement('a');
  anchor.href = dataUrl;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
