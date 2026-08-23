import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Check from 'lucide-react/dist/esm/icons/check';
import Ban from 'lucide-react/dist/esm/icons/ban';
import Copy from 'lucide-react/dist/esm/icons/copy';
import Download from 'lucide-react/dist/esm/icons/download';
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw';
import ShieldAlert from 'lucide-react/dist/esm/icons/shield-alert';
import Link2 from 'lucide-react/dist/esm/icons/link-2';
import X from 'lucide-react/dist/esm/icons/x';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { PublicJoinLink } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { SelectMenu, type SelectMenuOption } from '@/components/ui/SelectMenu';
import { StatePanel } from '@/components/ui/StatePanel';
import { formatGermanDateTime } from '@/features/shared/dateFormat';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import styles from './PublicJoinLinkDialog.module.css';

type LifetimeChoice = '1h' | '6h' | '24h' | '7d' | '30d' | 'custom' | 'unlimited';
type Confirmation = 'rotate' | 'disable' | null;

const LIFETIME_MILLISECONDS: Readonly<Partial<Record<LifetimeChoice, number>>> = {
  '1h': 60 * 60 * 1_000,
  '6h': 6 * 60 * 60 * 1_000,
  '24h': 24 * 60 * 60 * 1_000,
  '7d': 7 * 24 * 60 * 60 * 1_000,
  '30d': 30 * 24 * 60 * 60 * 1_000,
};

/** Properties accepted by the public join-link administration modal. */
export interface PublicJoinLinkDialogProps {
  groupId: string;
  onClose: () => void;
}

function localDateTimeValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function expiryFor(choice: LifetimeChoice, customExpiry: string): string | null {
  if (choice === 'unlimited') return null;
  if (choice === 'custom') return new Date(customExpiry).toISOString();
  return new Date(Date.now() + (LIFETIME_MILLISECONDS[choice] ?? 0)).toISOString();
}

function downloadDataURL(dataURL: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = dataURL;
  anchor.download = filename;
  anchor.click();
}

/**
 * Renders lifecycle controls, local QR generation, and secure sharing actions
 * for the group's single public join link.
 *
 * @param props - Group scope and close callback.
 * @returns A responsive administrator-only modal.
 */
export function PublicJoinLinkDialog({ groupId, onClose }: PublicJoinLinkDialogProps) {
  const { t } = useTranslation();
  const compact = useMediaQuery('(max-width: 767px)');
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['public-join-link', groupId] as const, [groupId]);
	const [openedAt] = useState(() => Date.now());
  const [lifetime, setLifetime] = useState<LifetimeChoice>('24h');
	const [lifetimeTouched, setLifetimeTouched] = useState(false);
  const [customExpiry, setCustomExpiry] = useState(() => localDateTimeValue(new Date(Date.now() + 24 * 60 * 60 * 1_000)));
	const [customExpiryTouched, setCustomExpiryTouched] = useState(false);
	const [qrImage, setQrImage] = useState({ url: '', dataURL: '' });
  const [copied, setCopied] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const linkQuery = useQuery({ queryKey, queryFn: () => api.getPublicJoinLink(groupId), staleTime: 15_000 });
  const link = linkQuery.data;
  const active = Boolean(link?.enabled && !link.expired);
	const storedLifetime: LifetimeChoice = active ? (link?.expiresAt ? 'custom' : 'unlimited') : '24h';
	const selectedLifetime = lifetimeTouched ? lifetime : storedLifetime;
	const selectedCustomExpiry = customExpiryTouched || !link?.expiresAt ? customExpiry : localDateTimeValue(new Date(link.expiresAt));
	const qrDataURL = link?.acceptUrl && qrImage.url === link.acceptUrl ? qrImage.dataURL : '';

  useEffect(() => {
    let cancelled = false;
    if (!active || !link?.acceptUrl) return undefined;
    void import('qrcode').then(({ toDataURL }) => toDataURL(link.acceptUrl!, { errorCorrectionLevel: 'M', margin: 2, width: 320 }))
		.then((dataURL) => { if (!cancelled) setQrImage({ url: link.acceptUrl!, dataURL }); })
		.catch(() => { if (!cancelled) setQrImage({ url: link.acceptUrl!, dataURL: '' }); });
    return () => { cancelled = true; };
  }, [active, link?.acceptUrl]);

  const updateMutation = useMutation({
    mutationFn: (update: { enabled: boolean; expiresAt: string | null }) => api.updatePublicJoinLink(groupId, update, link?.version ?? 0),
    onSuccess: (updated) => {
      queryClient.setQueryData<PublicJoinLink>(queryKey, updated);
      setConfirmation(null);
		setLifetimeTouched(false);
		setCustomExpiryTouched(false);
    },
  });
  const rotateMutation = useMutation({
    mutationFn: () => api.rotatePublicJoinLink(groupId, link?.version ?? 0),
    onSuccess: (updated) => {
      queryClient.setQueryData<PublicJoinLink>(queryKey, updated);
      setConfirmation(null);
      setCopied(false);
    },
  });

  const minCustomExpiry = localDateTimeValue(new Date(openedAt + 60 * 60 * 1_000));
  const maxCustomExpiry = localDateTimeValue(new Date(openedAt + 365 * 24 * 60 * 60 * 1_000));
	const customExpiryMilliseconds = new Date(selectedCustomExpiry).getTime();
	const invalidCustomExpiry = selectedLifetime === 'custom' && (!selectedCustomExpiry || customExpiryMilliseconds < openedAt + 60 * 60 * 1_000 || customExpiryMilliseconds > openedAt + 365 * 24 * 60 * 60 * 1_000);
  const pending = updateMutation.isPending || rotateMutation.isPending;
  const mutationError = updateMutation.error ?? rotateMutation.error;
  const lifetimeOptions: readonly SelectMenuOption<LifetimeChoice>[] = [
    { value: '1h', label: t('publicJoin.lifetimes.oneHour') },
    { value: '6h', label: t('publicJoin.lifetimes.sixHours') },
    { value: '24h', label: t('publicJoin.lifetimes.oneDay') },
    { value: '7d', label: t('publicJoin.lifetimes.sevenDays') },
    { value: '30d', label: t('publicJoin.lifetimes.thirtyDays') },
    { value: 'custom', label: t('publicJoin.lifetimes.custom') },
    { value: 'unlimited', label: t('publicJoin.lifetimes.unlimited') },
  ];

  const applyLifetime = () => {
    if (invalidCustomExpiry) return;
	updateMutation.mutate({ enabled: true, expiresAt: expiryFor(selectedLifetime, selectedCustomExpiry) });
  };
  const disable = () => updateMutation.mutate({ enabled: false, expiresAt: link?.expiresAt ?? null });
  const copyLink = async () => {
    if (!link?.acceptUrl) return;
    await navigator.clipboard.writeText(link.acceptUrl);
    setCopied(true);
  };

  return (
    <Modal onClose={onClose} open size="wide" title={t('publicJoin.adminTitle')} variant={compact ? 'sheet' : 'dialog'}>
      <div className={styles.content}>
        {linkQuery.isLoading ? <StatePanel kind="loading" /> : null}
        {linkQuery.isError ? <StatePanel kind="error" message={linkQuery.error.message} /> : null}
        {link && !link.emailVerificationAvailable ? (
          <section className={styles.unavailable} role="status">
            <ShieldAlert aria-hidden="true" size={24} />
            <div><h3>{t('publicJoin.unavailableTitle')}</h3><p>{t('publicJoin.unavailableDescription')}</p></div>
          </section>
        ) : null}

        {active && link?.acceptUrl ? (
          <>
            <section className={styles.sharePanel}>
              <div className={styles.statusRow}><span className={styles.activeBadge}><Check size={16} />{t('publicJoin.active')}</span><span>{link.expiresAt ? t('publicJoin.validUntil', { date: formatGermanDateTime(link.expiresAt) }) : t('publicJoin.unlimited')}</span></div>
              <div className={styles.qrFrame}>{qrDataURL ? <img alt={t('publicJoin.qrAlt')} height={240} src={qrDataURL} width={240} /> : <span>{t('publicJoin.qrLoading')}</span>}</div>
              <div className={styles.linkRow}><TextInput aria-label={t('publicJoin.linkLabel')} readOnly value={link.acceptUrl} /><Button leadingIcon={copied ? <Check size={17} /> : <Copy size={17} />} onClick={() => void copyLink()} variant="secondary">{copied ? t('common.copied') : t('common.copy')}</Button></div>
              <Button disabled={!qrDataURL} leadingIcon={<Download size={17} />} onClick={() => downloadDataURL(qrDataURL, 'teamtaler-join-qr.png')} size="small" variant="ghost">{t('publicJoin.downloadQr')}</Button>
            </section>
          </>
        ) : null}

        {link && link.emailVerificationAvailable && (!active || confirmation === null) ? (
          <section className={styles.settingsPanel}>
            <h3>{active ? t('publicJoin.changeLifetime') : link.expired ? t('publicJoin.expiredTitle') : t('publicJoin.createTitle')}</h3>
            <Field htmlFor="public-join-lifetime" label={t('publicJoin.lifetime')}>
              <SelectMenu id="public-join-lifetime" onChange={(choice) => { setLifetime(choice); setLifetimeTouched(true); }} options={lifetimeOptions} value={selectedLifetime} />
            </Field>
			{selectedLifetime === 'custom' ? <Field error={invalidCustomExpiry ? t('publicJoin.customInvalid') : undefined} htmlFor="public-join-custom-expiry" label={t('publicJoin.customExpiry')}><TextInput id="public-join-custom-expiry" max={maxCustomExpiry} min={minCustomExpiry} onChange={(event) => { setCustomExpiry(event.target.value); setCustomExpiryTouched(true); }} type="datetime-local" value={selectedCustomExpiry} /></Field> : null}
			{selectedLifetime === 'unlimited' ? <p className={styles.securityWarning}><ShieldAlert aria-hidden="true" size={19} />{t('publicJoin.unlimitedWarning')}</p> : null}
            <ModalFooter><div className={styles.actions}>
              {active ? <Button disabled={pending} leadingIcon={<Ban size={17} />} onClick={() => setConfirmation('disable')} variant="danger">{t('publicJoin.disable')}</Button> : null}
              {active ? <Button disabled={pending} leadingIcon={<RefreshCw size={17} />} onClick={() => setConfirmation('rotate')} variant="secondary">{t('publicJoin.rotate')}</Button> : null}
              <Button disabled={pending || invalidCustomExpiry} leadingIcon={<Link2 size={17} />} onClick={applyLifetime}>{active ? t('publicJoin.saveLifetime') : link.expired ? t('publicJoin.reactivate') : t('publicJoin.create')}</Button>
            </div></ModalFooter>
          </section>
        ) : null}

        {confirmation ? (
          <section className={styles.confirmation} role="alert">
            <h3>{confirmation === 'rotate' ? t('publicJoin.rotateConfirmTitle') : t('publicJoin.disableConfirmTitle')}</h3>
            <p>{confirmation === 'rotate' ? t('publicJoin.rotateConfirmDescription') : t('publicJoin.disableConfirmDescription')}</p>
            <ModalFooter><div className={styles.actions}><Button disabled={pending} leadingIcon={<X size={17} />} onClick={() => setConfirmation(null)} variant="secondary">{t('common.cancel')}</Button><Button disabled={pending} leadingIcon={confirmation === 'disable' ? <Ban size={17} /> : <RefreshCw size={17} />} onClick={() => confirmation === 'rotate' ? rotateMutation.mutate() : disable()} variant={confirmation === 'disable' ? 'danger' : 'primary'}>{t('common.confirm')}</Button></div></ModalFooter>
          </section>
        ) : null}

        {mutationError ? <p className={styles.error} role="alert">{mutationError.message}</p> : null}
      </div>
    </Modal>
  );
}
