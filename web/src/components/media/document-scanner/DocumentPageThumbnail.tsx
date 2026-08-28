import { useEffect, useState } from 'react';
import { renderDocumentPage } from './imageProcessing';
import type { ScannerPage } from './types';
import styles from './DocumentScannerWorkspace.module.css';

const THUMBNAIL_MAXIMUM_EDGE = 720;

/** Properties for a scanner thumbnail rendered from committed page edits. */
interface DocumentPageThumbnailProps {
  /** Accessible page label supplied by the ordered scanner workspace. */
  alt: string;
  /** Committed source page, crop, rotation, and enhancement state. */
  page: ScannerPage;
}

/**
 * Renders the same cropped and enhanced result that will be embedded in the PDF.
 *
 * @param props - Accessible label and committed scanner page.
 * @returns A bounded asynchronous page image with the source preview as a loading fallback.
 */
export function DocumentPageThumbnail({ alt, page }: DocumentPageThumbnailProps) {
  const [processedPreview, setProcessedPreview] = useState<{ page: ScannerPage; url: string }>();

  useEffect(() => {
    let disposed = false;
    let ownedUrl = '';
    void renderDocumentPage(page, THUMBNAIL_MAXIMUM_EDGE).then((rendered) => {
      if (disposed) return;
      ownedUrl = URL.createObjectURL(rendered.blob);
      setProcessedPreview({ page, url: ownedUrl });
    }, () => undefined);
    return () => {
      disposed = true;
      if (ownedUrl) URL.revokeObjectURL(ownedUrl);
    };
  }, [page]);
  const renderedUrl = processedPreview?.page === page ? processedPreview.url : '';

  return (
    <span aria-busy={!renderedUrl} className={styles.thumbnailResult}>
      <img alt={alt} data-rendered-preview={Boolean(renderedUrl)} src={renderedUrl || page.previewUrl} />
    </span>
  );
}
