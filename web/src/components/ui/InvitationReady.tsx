import Copy from 'lucide-react/dist/esm/icons/copy';
import CircleCheck from 'lucide-react/dist/esm/icons/circle-check';
import MailPlus from 'lucide-react/dist/esm/icons/mail-plus';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './Button';
import { TextInput } from './FormField';
import styles from './InvitationReady.module.css';

/** Visual delivery state shown after an invitation has been created. */
export interface InvitationReadyStatus {
  /** Short status heading. */
  title: string;
  /** Human-readable explanation of the delivery state. */
  description: string;
  /** Whether the delivery state represents a failure. */
  error?: boolean;
}

/** Properties for the shared invitation-result view. */
export interface InvitationReadyProps {
  /** One-time invitation URL returned by the API. */
  acceptUrl: string;
  /** Current email-delivery state rendered as a prominent notice. */
  deliveryStatus: InvitationReadyStatus;
  /** Optional error shown when the latest delivery state cannot be loaded. */
  errorMessage?: string;
  /** ISO timestamp at which the invitation becomes invalid. */
  expiresAt: string;
  /** Optional guidance explaining why the link should be retained. */
  fallbackHint?: string;
  /** Accessible name for the read-only link field. */
  linkLabel: string;
}

/** Properties accepted by the persistent invitation-result action. */
export interface InvitationReadyFooterProps {
  /** Closes the surrounding dialog. */
  onDone: () => void;
}

/**
 * Renders the canonical TeamTaler invitation success experience.
 *
 * @param props - Link, delivery state, expiry copy, and close callback.
 * @returns A consistent invitation result with copy feedback for use above a persistent modal footer.
 */
export function InvitationReady({ acceptUrl, deliveryStatus, errorMessage, expiresAt, fallbackHint, linkLabel }: InvitationReadyProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copyLink = async () => {
    await navigator.clipboard.writeText(acceptUrl);
    setCopied(true);
  };

  return (
    <div className={styles.root}>
      <MailPlus aria-hidden="true" size={38} />
      <section aria-live="polite" className={`${styles.deliveryNotice} ${deliveryStatus.error ? styles.deliveryNoticeError : ''}`} role="status">
        <h3>{deliveryStatus.title}</h3>
        <p>{deliveryStatus.description}</p>
      </section>
      {errorMessage ? <p className={styles.error} role="alert">{errorMessage}</p> : null}
      <p>{t('members.invitationExpiry', { date: new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(expiresAt)) })}</p>
      <div className={styles.fallbackLink}>
        {fallbackHint ? <p>{fallbackHint}</p> : null}
        <div className={styles.copyRow}>
          <TextInput aria-label={linkLabel} readOnly value={acceptUrl} />
          <Button leadingIcon={<Copy size={17} />} onClick={() => void copyLink()} variant="secondary">{copied ? t('common.copied') : t('common.copy')}</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Renders the persistent completion action for an invitation result modal.
 *
 * @param props - Completion callback owned by the surrounding workflow.
 * @returns A full-width action intended for the shared modal footer.
 */
export function InvitationReadyFooter({ onDone }: InvitationReadyFooterProps) {
  const { t } = useTranslation();
  return <Button fullWidth leadingIcon={<CircleCheck size={17} />} onClick={onDone}>{t('common.done')}</Button>;
}
