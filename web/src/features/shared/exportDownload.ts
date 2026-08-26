const PDF_PREVIEW_URL_LIFETIME_MS = 5 * 60 * 1_000;

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
