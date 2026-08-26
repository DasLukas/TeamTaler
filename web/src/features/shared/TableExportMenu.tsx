import { useMutation } from '@tanstack/react-query';
import Download from 'lucide-react/dist/esm/icons/download';
import FileSpreadsheet from 'lucide-react/dist/esm/icons/file-spreadsheet';
import FileText from 'lucide-react/dist/esm/icons/file-text';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { TableExportCommand, TableExportFormat, TableExportId } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { downloadExportBlob, openPdfPreviewWindow, showPdfInPreviewWindow } from './exportDownload';
import styles from './TableExportMenu.module.css';

/** Server-owned configuration for one complete filtered and sorted table export. */
export interface TableExportConfig {
  table: TableExportId;
  title: string;
  query: Record<string, unknown>;
  groupId?: string;
  system?: boolean;
  disabled?: boolean;
}

/** Properties accepted by the reusable table-export action. */
export interface TableExportMenuProps extends TableExportConfig {
  disabled?: boolean;
}

function safeFileStem(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLocaleLowerCase('de-DE') || 'export';
}

/**
 * Renders an accessible format chooser for a server-rendered table export.
 *
 * @param props - Stable table identifier, current query, title, and authorization scope.
 * @returns A button and modal offering CSV download and native PDF preview.
 */
export function TableExportMenu({ disabled = false, groupId, query, system = false, table, title }: TableExportMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: async ({ format, previewWindow }: { format: TableExportFormat; previewWindow?: Window | null }) => {
      if (format === 'PDF' && !previewWindow) throw new Error(t('exports.table.previewBlocked'));
      const command: TableExportCommand = {
        table,
        format,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        query,
      };
      let blob: Blob;
      if (system) blob = await api.exportSystemTable(command);
      else {
        if (!groupId) throw new Error(t('exports.groupMissing'));
        blob = await api.exportGroupTable(groupId, command);
      }
      const extension = format.toLocaleLowerCase('en-US');
      const fileName = `${safeFileStem(title)}-${new Date().toISOString().slice(0, 10)}.${extension}`;
      if (format === 'PDF') {
        if (!showPdfInPreviewWindow(previewWindow!, blob, fileName)) throw new Error(t('exports.table.previewClosed'));
      } else {
        downloadExportBlob(blob, fileName);
      }
    },
    onError: (_error, variables) => {
      if (variables.previewWindow && !variables.previewWindow.closed) variables.previewWindow.close();
    },
    onSuccess: () => {
      setOpen(false);
    },
  });
  const startExport = (format: TableExportFormat) => {
    mutation.reset();
    const previewWindow = format === 'PDF'
      ? openPdfPreviewWindow(t('exports.table.previewTitle', { title }), t('exports.table.previewLoading'))
      : undefined;
    mutation.mutate({ format, previewWindow });
  };

  return (
    <div className={styles.triggerWrap}>
      <Button aria-label={t('exports.table.action')} disabled={disabled || mutation.isPending} iconOnly leadingIcon={<Download size={18} />} onClick={() => { mutation.reset(); setOpen(true); }} title={t('exports.table.action')} variant="secondary">
        {t('exports.table.action')}
      </Button>
      <Modal onClose={() => setOpen(false)} open={open} title={t('exports.table.title', { title })}>
        <div className={styles.content}>
          <p className={styles.intro}>{t('exports.table.intro')}</p>
          <div className={styles.actions}>
            <Button disabled={mutation.isPending} leadingIcon={<FileSpreadsheet size={18} />} onClick={() => startExport('CSV')} variant="secondary">{t('exports.table.csv')}</Button>
            <Button disabled={mutation.isPending} leadingIcon={<FileText size={18} />} onClick={() => startExport('PDF')}>{t('exports.table.pdf')}</Button>
          </div>
          {mutation.isError ? <p className={styles.error} role="alert">{mutation.error.message || t('exports.table.error')}</p> : null}
        </div>
      </Modal>
    </div>
  );
}
