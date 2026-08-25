/**
 * Starts a browser download without opening sensitive export content in another tab.
 *
 * @param blob - Complete response body returned by the export endpoint.
 * @param fileName - Safe local file name selected by the trusted client.
 * @returns Nothing.
 */
export function downloadExportBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
