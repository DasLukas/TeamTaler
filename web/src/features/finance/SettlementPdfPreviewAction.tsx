import { useMutation } from '@tanstack/react-query';
import Printer from 'lucide-react/dist/esm/icons/printer';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { Settlement, TableExportCommand } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { openPdfPreviewWindow, showPdfInPreviewWindow, tableExportFileName } from '@/features/shared/exportDownload';
import styles from './SettlementPdfPreviewAction.module.css';

export interface SettlementPdfPreviewActionProps {
  groupId: string;
  settlement: Settlement;
}

interface SettlementPreviewVariables {
  previewWindow: Window | null;
}

/**
 * Opens a native browser PDF preview containing every booking line assigned to
 * one immutable member settlement.
 *
 * @param props - Active group scope and the exact period/member settlement identity.
 * @returns An accessible row action with pending and error feedback.
 */
export function SettlementPdfPreviewAction({ groupId, settlement }: SettlementPdfPreviewActionProps) {
  const { t } = useTranslation();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const exportTitle = t('periods.statementExportTitle', { member: settlement.memberName, period: settlement.periodLabel });
  const mutation = useMutation({
    mutationFn: async ({ previewWindow }: SettlementPreviewVariables) => {
      if (!previewWindow) throw new Error(t('exports.table.previewBlocked'));
      const command: TableExportCommand = {
        format: 'PDF',
        query: {
          membershipId: settlement.membershipId,
          periodId: settlement.periodId,
        },
        table: 'SETTLEMENT_STATEMENT',
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      };
      let blob: Blob;
      try {
        blob = await api.exportGroupTable(groupId, command);
      } catch {
        throw new Error(t('periods.statementPreviewError'));
      }
      const fileName = tableExportFileName(exportTitle, 'pdf');
      if (!showPdfInPreviewWindow(previewWindow, blob, fileName)) throw new Error(t('exports.table.previewClosed'));
    },
    onError: (error, variables) => {
      if (variables.previewWindow && !variables.previewWindow.closed) variables.previewWindow.close();
      setErrorMessage(error instanceof Error && error.message ? error.message : t('periods.statementPreviewError'));
    },
    onSuccess: () => setErrorMessage(null),
  });

  const openPreview = () => {
    setErrorMessage(null);
    const previewWindow = openPdfPreviewWindow(
      t('exports.table.previewTitle', { title: exportTitle }),
      t('exports.table.previewLoading'),
    );
    mutation.mutate({ previewWindow });
  };

  return (
    <div className={styles.action}>
      <Button
        aria-label={t('periods.printFor', { member: settlement.memberName, period: settlement.periodLabel })}
        disabled={mutation.isPending}
        leadingIcon={<Printer size={16} />}
        onClick={openPreview}
        size="small"
        variant="ghost"
      >
        {mutation.isPending ? t('periods.preparingPdf') : t('common.print')}
      </Button>
      {errorMessage ? <p className={styles.error} role="alert">{errorMessage}</p> : null}
    </div>
  );
}
