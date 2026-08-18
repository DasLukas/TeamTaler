import AlertCircle from 'lucide-react/dist/esm/icons/circle-alert';
import Inbox from 'lucide-react/dist/esm/icons/inbox';
import LoaderCircle from 'lucide-react/dist/esm/icons/loader-circle';
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './Button';
import styles from './StatePanel.module.css';

/** Properties accepted by the shared query-state panel. */
export interface StatePanelProps {
  kind: 'loading' | 'empty' | 'error';
  title?: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  children?: ReactNode;
}

/**
 * Renders a standard loading, empty, or error state for a data region.
 *
 * @param props - State kind, localized copy, optional action, and content.
 * @returns An accessible live status or alert panel.
 */
export function StatePanel({ kind, title, message, actionLabel, onAction, children }: StatePanelProps) {
  const { t } = useTranslation();
  const Icon = kind === 'loading' ? LoaderCircle : kind === 'error' ? AlertCircle : Inbox;
  const defaultTitle = kind === 'loading' ? t('state.loadingTitle') : kind === 'error' ? t('state.errorTitle') : t('state.emptyTitle');
  return (
    <div aria-live="polite" className={styles.panel} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon aria-hidden="true" className={kind === 'loading' ? styles.spinning : ''} size={30} strokeWidth={1.7} />
      <h2>{title ?? defaultTitle}</h2>
      {message ? <p>{message}</p> : null}
      {children}
      {actionLabel && onAction ? <Button leadingIcon={<RefreshCw size={17} />} onClick={onAction} variant="secondary">{actionLabel}</Button> : null}
    </div>
  );
}
