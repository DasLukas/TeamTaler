import ArrowDown from 'lucide-react/dist/esm/icons/arrow-down';
import ArrowUp from 'lucide-react/dist/esm/icons/arrow-up';
import Check from 'lucide-react/dist/esm/icons/check';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import X from 'lucide-react/dist/esm/icons/x';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { createDocumentPdf } from './createDocumentPdf';
import { DocumentCamera } from './DocumentCamera';
import { DocumentCornerEditor } from './DocumentCornerEditor';
import { DEFAULT_DOCUMENT_CORNERS } from './geometry';
import { readImageDimensions } from './imageDimensions';
import { MAX_SCANNER_SOURCE_PIXELS, scannerSourceByteBudget } from './resourceLimits';
import type { DocumentCorners, ScannerPage } from './types';
import styles from './DocumentScannerWorkspace.module.css';

const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
let fallbackPageId = 0;

/** Properties accepted by the reusable document-scanner workspace. */
export interface DocumentScannerWorkspaceProps {
  /** Controls whether the scanner dialog is visible and camera resources are active. */
  open: boolean;
  /** Called when the user closes the scanner without producing a document. */
  onCancel: () => void;
  /** Receives exactly one generated, multi-page PDF file. */
  onComplete: (file: File) => void;
  /** Maximum accepted size of the generated PDF in bytes. */
  maxBytes: number;
  /** Maximum number of source pages; defaults to twenty. */
  maxPages?: number;
}

function pageId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  fallbackPageId += 1;
  return `scanner-page-${fallbackPageId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The scanned document could not be created.';
}

function editablePage(page: ScannerPage): ScannerPage {
  return {
    ...page,
    corners: page.corners.map((corner) => ({ ...corner })) as unknown as DocumentCorners,
  };
}

/**
 * Renders a self-contained multi-page document scanner.
 *
 * The shared modal fills the dynamic viewport through 1023px and becomes a
 * large centered workspace on desktop. Camera streams, detection workers,
 * image bitmaps, and preview URLs remain scoped to the open scanner lifetime.
 *
 * @param props - Visibility, lifecycle callbacks, upload limit, and page limit.
 * @returns An accessible scanner dialog, or its closed native dialog shell.
 */
export function DocumentScannerWorkspace({ open, onCancel, onComplete, maxBytes, maxPages = 20 }: DocumentScannerWorkspaceProps) {
  const { t } = useTranslation();
  const ownedUrlsRef = useRef(new Set<string>());
  const pagesRef = useRef<ScannerPage[]>([]);
  const appendQueueRef = useRef<Promise<void>>(Promise.resolve());
  const scannerSessionRef = useRef(0);
  const editorHeadingRef = useRef<HTMLHeadingElement>(null);
  const thumbnailRefs = useRef(new Map<string, HTMLButtonElement>());
  const returnFocusPageIdRef = useRef<string | undefined>(undefined);
  const [pages, setPages] = useState<ScannerPage[]>([]);
  const [selectedPageId, setSelectedPageId] = useState<string>();
  const [editorDraft, setEditorDraft] = useState<ScannerPage>();
  const [view, setView] = useState<'camera' | 'editor'>('camera');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pageLimit = Number.isFinite(maxPages) ? Math.max(1, Math.min(20, Math.floor(maxPages))) : 20;

  const releaseAllPages = useCallback(() => {
    scannerSessionRef.current += 1;
    for (const url of ownedUrlsRef.current) URL.revokeObjectURL(url);
    ownedUrlsRef.current.clear();
    pagesRef.current = [];
    setPages([]);
    setSelectedPageId(undefined);
    setEditorDraft(undefined);
  }, []);

  useEffect(() => { pagesRef.current = pages; }, [pages]);

  useEffect(() => {
    if (!open) {
      const resetTimer = window.setTimeout(() => {
        releaseAllPages();
        setBusy(false);
        setError('');
        setView('camera');
        setEditorDraft(undefined);
      }, 0);
      return () => window.clearTimeout(resetTimer);
    }
    return undefined;
  }, [open, releaseAllPages]);

  useEffect(() => () => {
    scannerSessionRef.current += 1;
    for (const url of ownedUrlsRef.current) URL.revokeObjectURL(url);
    ownedUrlsRef.current.clear();
  }, []);

  const appendFiles = useCallback((files: readonly File[], corners?: DocumentCorners): Promise<void> => {
    const session = scannerSessionRef.current;
    const operation = appendQueueRef.current.then(async () => {
      if (session !== scannerSessionRef.current) return;
      setError('');
      const room = Math.max(0, pageLimit - pagesRef.current.length);
      const candidates = files.slice(0, room);
      let sourceBytes = pagesRef.current.reduce((total, page) => total + page.file.size, 0);
      let sourcePixels = pagesRef.current.reduce((total, page) => total + page.sourceWidth * page.sourceHeight, 0);
      const sourceByteBudget = scannerSourceByteBudget(maxBytes);
      const accepted: Array<{ dimensions: { height: number; width: number }; file: File }> = [];
      let resourceBudgetRejected = false;
      let invalidFileRejected = candidates.length !== files.length;

      for (const file of candidates) {
        if (!SUPPORTED_IMAGE_TYPES.has(file.type) || file.size <= 0 || file.size > maxBytes) {
          invalidFileRejected = true;
          continue;
        }
        try {
          const dimensions = await readImageDimensions(file);
          if (session !== scannerSessionRef.current) return;
          const nextBytes = sourceBytes + file.size;
          const nextPixels = sourcePixels + dimensions.width * dimensions.height;
          if (nextBytes > sourceByteBudget || nextPixels > MAX_SCANNER_SOURCE_PIXELS) {
            resourceBudgetRejected = true;
            continue;
          }
          accepted.push({ dimensions, file });
          sourceBytes = nextBytes;
          sourcePixels = nextPixels;
        } catch {
          invalidFileRejected = true;
        }
      }

      if (resourceBudgetRejected) {
        setError(t('documentScanner.resourceBudgetExceeded', { defaultValue: 'The captured pages exceed the safe scan memory budget. Remove pages or finish the scan.' }));
      } else if (invalidFileRejected) {
        setError(t('documentScanner.someFilesRejected', { defaultValue: 'The captured page could not be processed.' }));
      }
      if (accepted.length === 0) return;
      const additions = accepted.map(({ dimensions, file }): ScannerPage => {
        const previewUrl = URL.createObjectURL(file);
        ownedUrlsRef.current.add(previewUrl);
        return {
          corners: corners ?? DEFAULT_DOCUMENT_CORNERS,
          file,
          filter: 'color',
          id: pageId(),
          previewUrl,
          rotation: 0,
          sourceHeight: dimensions.height,
          sourceWidth: dimensions.width,
        };
      });
      setPages((current) => {
        const next = [...current, ...additions];
        pagesRef.current = next;
        return next;
      });
      setSelectedPageId(additions[0].id);
    });
    appendQueueRef.current = operation.catch(() => undefined);
    return operation;
  }, [maxBytes, pageLimit, t]);

  const capturePage = useCallback((file: File, corners: DocumentCorners) => {
    void appendFiles([file], corners);
  }, [appendFiles]);

  const openEditor = (page: ScannerPage) => {
    setSelectedPageId(page.id);
    setEditorDraft(editablePage(page));
    setView('editor');
  };

  const closeEditor = useCallback(() => {
    const pageIdToFocus = editorDraft?.id;
    returnFocusPageIdRef.current = pageIdToFocus;
    setEditorDraft(undefined);
    setView('camera');
  }, [editorDraft?.id]);

  const applyEditor = () => {
    if (!editorDraft) return;
    setPages((current) => {
      const next = current.map((page) => page.id === editorDraft.id ? editorDraft : page);
      pagesRef.current = next;
      return next;
    });
    closeEditor();
  };

  useEffect(() => {
    if (view === 'editor') {
      editorHeadingRef.current?.focus();
      return;
    }
    const pageIdToFocus = returnFocusPageIdRef.current;
    if (!pageIdToFocus) return;
    returnFocusPageIdRef.current = undefined;
    window.requestAnimationFrame(() => thumbnailRefs.current.get(pageIdToFocus)?.focus());
  }, [view]);

  const removePage = (id: string) => {
    if (pages.length === 1 && pages[0]?.id === id) setView('camera');
    setPages((current) => {
      const removed = current.find((page) => page.id === id);
      if (removed) {
        URL.revokeObjectURL(removed.previewUrl);
        ownedUrlsRef.current.delete(removed.previewUrl);
      }
      const next = current.filter((page) => page.id !== id);
      pagesRef.current = next;
      setSelectedPageId((selected) => selected === id ? next[0]?.id : selected);
      return next;
    });
  };

  const movePage = (id: string, offset: -1 | 1) => {
    setPages((current) => {
      const index = current.findIndex((page) => page.id === id);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      pagesRef.current = next;
      return next;
    });
  };

  const complete = async () => {
    if (pages.length === 0 || busy) return;
    setBusy(true);
    setError('');
    try {
      onComplete(await createDocumentPdf(pages, maxBytes));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const selectedPage = pages.find((page) => page.id === selectedPageId) ?? pages[0];
  const pageLimitReached = pages.length >= pageLimit;
  const editing = view === 'editor' && editorDraft !== undefined;
  const footer = editing ? (
    <div className={styles.footerActions}>
      <Button leadingIcon={<X size={17} />} onClick={closeEditor} variant="secondary">
        {t('common.cancel', { defaultValue: 'Cancel' })}
      </Button>
      <Button leadingIcon={<Check size={17} />} onClick={applyEditor}>
        {t('documentScanner.applyChanges', { defaultValue: 'Apply' })}
      </Button>
    </div>
  ) : (
    <div className={styles.footerActions}>
      <Button disabled={busy} leadingIcon={<X size={17} />} onClick={onCancel} variant="secondary">
        {t('common.cancel', { defaultValue: 'Cancel' })}
      </Button>
      <Button disabled={pages.length === 0 || busy} leadingIcon={<Check size={17} />} onClick={() => void complete()}>
        {busy ? t('documentScanner.creating', { defaultValue: 'Creating PDF…' }) : t('documentScanner.useDocument', { defaultValue: 'Use document' })}
      </Button>
    </div>
  );

  return (
    <Modal
      bodyClassName={styles.modalBody}
      className={styles.modal}
      footer={footer}
      onClose={() => {
        if (busy) return;
        if (editing) closeEditor();
        else onCancel();
      }}
      open={open}
      headerMode="accessible-only"
      size="workspace"
      title={t('documentScanner.title', { defaultValue: 'Scan document' })}
      variant="fullscreen"
    >
      <div className={`${styles.workspace} ${editing ? styles.editorWorkspace : ''}`}>
        <div className={`${styles.content} ${editing ? styles.editorContent : ''}`}>
        {editing ? (
          <>
            <h3 className={styles.editorTitle} ref={editorHeadingRef} tabIndex={-1}>
              {t('documentScanner.editTitle', { defaultValue: 'Edit scan' })}
            </h3>
            <DocumentCornerEditor
              onChange={setEditorDraft}
              page={editorDraft}
            />
          </>
        ) : (
          <DocumentCamera
            active={open && !pageLimitReached}
            onCapture={capturePage}
          />
        )}
        </div>

        {!editing ? (
          <aside aria-label={t('documentScanner.pages', { defaultValue: 'Scanned pages' })} className={`${styles.pageStrip} ${pages.length === 0 ? styles.emptyPageStrip : ''}`}>
          <p className={styles.accessiblePageCount}>{t('documentScanner.pageCount', { count: pages.length, defaultValue: `${pages.length} of ${pageLimit} pages`, maxPages: pageLimit })}</p>
          {pages.length === 0 ? <p className={styles.emptyPages}>{t('documentScanner.emptyPages', { defaultValue: 'Ready for the first scan' })}</p> : null}
          {pages.map((page, index) => (
            <article className={`${styles.thumbnail} ${page.id === selectedPage?.id ? styles.selectedThumbnail : ''}`} key={page.id}>
              <button
                className={styles.thumbnailPreview}
                onClick={() => openEditor(page)}
                ref={(node) => {
                  if (node) thumbnailRefs.current.set(page.id, node);
                  else thumbnailRefs.current.delete(page.id);
                }}
                type="button"
              >
                <img alt={t('documentScanner.pageNumber', { number: index + 1, defaultValue: `Page ${index + 1}` })} src={page.previewUrl} />
                <span>{index + 1}</span>
              </button>
              <div className={styles.thumbnailActions}>
                <button aria-label={t('documentScanner.moveEarlier', { defaultValue: 'Move page earlier' })} disabled={index === 0} onClick={() => movePage(page.id, -1)} type="button"><ArrowUp size={15} /></button>
                <button aria-label={t('documentScanner.moveLater', { defaultValue: 'Move page later' })} disabled={index === pages.length - 1} onClick={() => movePage(page.id, 1)} type="button"><ArrowDown size={15} /></button>
                <button aria-label={t('documentScanner.deletePage', { defaultValue: 'Delete page' })} onClick={() => removePage(page.id)} type="button"><Trash2 size={15} /></button>
              </div>
            </article>
          ))}
          </aside>
        ) : null}

        {error ? <p className={styles.error} role="alert">{error}</p> : null}
      </div>
    </Modal>
  );
}
