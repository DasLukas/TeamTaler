const PDF_PREVIEW_URL_LIFETIME_MS = 5 * 60 * 1_000;

function safeFileStem(value: string): string {
  return value
    .normalize('NFC')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '') || 'Export';
}

function localISODate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Builds the browser-facing filename for a localized table export.
 *
 * @param title - Localized export title.
 * @param extension - Lowercase file extension without a leading dot.
 * @param exportedAt - Local export timestamp used for the date prefix.
 * @param dateFirst - Whether the local date precedes the title, as required for PDF previews.
 * @returns A filesystem-safe filename with the canonical local date placement.
 */
export function tableExportFileName(title: string, extension: string, exportedAt = new Date(), dateFirst = true): string {
  const date = localISODate(exportedAt);
  const stem = safeFileStem(title);
  return dateFirst ? `${date}_${stem}.${extension}` : `${stem}-${date}.${extension}`;
}

/**
 * Starts a browser download for export formats that have no native preview.
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

/**
 * Opens a same-origin placeholder tab synchronously so browsers recognize it
 * as part of the user's click and do not block the later PDF navigation.
 *
 * @param title - Accessible title shown while the server renders the PDF.
 * @param loadingLabel - Localized progress copy shown in the placeholder tab.
 * @returns The opened preview window, or null when the browser blocks popups.
 */
export function openPdfPreviewWindow(title: string, loadingLabel: string): Window | null {
  const previewWindow = window.open('about:blank', '_blank');
  if (!previewWindow) return null;
  previewWindow.opener = null;
  previewWindow.document.title = title;
  const status = previewWindow.document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = loadingLabel;
  status.style.cssText = 'font: 16px/1.5 system-ui, sans-serif; margin: 2rem; color: #101725;';
  previewWindow.document.body.replaceChildren(status);
  return previewWindow;
}

/**
 * Navigates a prepared tab to a local PDF object URL for native browser preview.
 * The URL remains valid long enough for large documents and is then released.
 *
 * @param previewWindow - Placeholder tab created by openPdfPreviewWindow.
 * @param blob - Complete PDF response returned by the export endpoint.
 * @param fileName - Safe file name retained by browsers that inspect File metadata.
 * @returns True after navigation, or false when the tab was closed or inaccessible.
 */
export function showPdfInPreviewWindow(previewWindow: Window, blob: Blob, fileName: string): boolean {
  if (previewWindow.closed) return false;
  const pdf = new File([blob], fileName, { type: 'application/pdf' });
  const url = URL.createObjectURL(pdf);
  try {
    previewWindow.location.replace(url);
  } catch {
    URL.revokeObjectURL(url);
    return false;
  }
  window.setTimeout(() => URL.revokeObjectURL(url), PDF_PREVIEW_URL_LIFETIME_MS);
  return true;
}
