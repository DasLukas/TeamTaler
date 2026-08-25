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
import { downloadExportBlob } from './exportDownload';
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
 * @returns A button and modal offering CSV and PDF downloads.
 */
export function TableExportMenu({ disabled = false, groupId, query, system = false, table, title }: TableExportMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: async (format: TableExportFormat) => {
      const command: TableExportCommand = {
        table,
        format,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        query,
      };
      if (system) return api.exportSystemTable(command);
      if (!groupId) throw new Error(t('exports.groupMissing'));
      return api.exportGroupTable(groupId, command);
    },
    onSuccess: (blob, format) => {
      const extension = format.toLocaleLowerCase('en-US');
      downloadExportBlob(blob, `${safeFileStem(title)}-${new Date().toISOString().slice(0, 10)}.${extension}`);
      setOpen(false);
    },
  });
  const startExport = (format: TableExportFormat) => {
    mutation.reset();
    mutation.mutate(format);
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
