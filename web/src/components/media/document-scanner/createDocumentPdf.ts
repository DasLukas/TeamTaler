import { renderDocumentPage } from './imageProcessing';
import { MAX_SCANNER_RENDERED_PIXELS, MAX_SCANNER_SOURCE_PIXELS, scannerSourceByteBudget } from './resourceLimits';
import type { ScannerPage } from './types';

const MAX_PDF_EDGE_POINTS = 842;
const PDF_CHECKPOINT_INTERVAL = 4;

/**
 * Produces one portable, multi-page PDF from the edited local scan pages.
 *
 * `pdf-lib` is loaded only when the user finishes a scan, keeping the heavy
 * dependency out of the scanner's initial application chunk.
 *
 * @param pages - Ordered local pages to render into the PDF.
 * @param maxBytes - Maximum accepted final PDF size in bytes.
 * @returns A newly generated `application/pdf` file.
 * @throws {Error} When there are no pages or the generated PDF exceeds the limit.
 */
export async function createDocumentPdf(pages: readonly ScannerPage[], maxBytes: number): Promise<File> {
  if (pages.length === 0) throw new Error('Add at least one page before creating the document.');
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('The PDF size limit must be positive.');
  const sourceBytes = pages.reduce((total, page) => total + page.file.size, 0);
  const sourcePixels = pages.reduce((total, page) => total + page.sourceWidth * page.sourceHeight, 0);
  if (sourceBytes > scannerSourceByteBudget(maxBytes) || sourcePixels > MAX_SCANNER_SOURCE_PIXELS) {
    throw new Error('The selected pages exceed the safe scan resource budget.');
  }

  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  let embeddedBytes = 0;
  let renderedPixels = 0;
  let finalBytes: Uint8Array<ArrayBufferLike> | undefined;
  for (let index = 0; index < pages.length; index += 1) {
    const scannerPage = pages[index];
    const rendered = await renderDocumentPage(scannerPage);
    renderedPixels += rendered.width * rendered.height;
    if (renderedPixels > MAX_SCANNER_RENDERED_PIXELS) {
      throw new Error('The rendered pages exceed the safe scan pixel budget.');
    }
    embeddedBytes += rendered.blob.size;
    if (embeddedBytes > maxBytes) {
      throw new Error(`The scanned PDF exceeds the ${maxBytes}-byte upload limit.`);
    }
    const image = await pdf.embedJpg(await rendered.blob.arrayBuffer());
    const scale = MAX_PDF_EDGE_POINTS / Math.max(rendered.width, rendered.height);
    const width = rendered.width * scale;
    const height = rendered.height * scale;
    const page = pdf.addPage([width, height]);
    page.drawImage(image, { height, width, x: 0, y: 0 });
    const isLastPage = index === pages.length - 1;
    if (isLastPage || (index + 1) % PDF_CHECKPOINT_INTERVAL === 0 || embeddedBytes > maxBytes * 0.75) {
      const checkpoint = await pdf.save({ addDefaultPage: false, useObjectStreams: true });
      if (checkpoint.byteLength > maxBytes) {
        throw new Error(`The scanned PDF exceeds the ${maxBytes}-byte upload limit.`);
      }
      if (isLastPage) finalBytes = checkpoint;
    }
  }
  const bytes = finalBytes ?? await pdf.save({ addDefaultPage: false, useObjectStreams: true });
  if (bytes.byteLength > maxBytes) {
    throw new Error(`The scanned PDF exceeds the ${maxBytes}-byte upload limit.`);
  }
  return new File([bytes as Uint8Array<ArrayBuffer>], `document-scan-${new Date().toISOString().replaceAll(':', '-')}.pdf`, {
    lastModified: Date.now(),
    type: 'application/pdf',
  });
}
