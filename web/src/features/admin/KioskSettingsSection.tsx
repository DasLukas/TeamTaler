import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Download from 'lucide-react/dist/esm/icons/download';
import Plus from 'lucide-react/dist/esm/icons/plus';
import X from 'lucide-react/dist/esm/icons/x';
import Save from 'lucide-react/dist/esm/icons/save';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { GroupSettings, KioskPoster, KioskPosterInput, Session } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Toggle } from '@/components/ui/Toggle';
import { downloadExportBlob } from '@/features/shared/exportDownload';
import { PosterProductComposer } from './PosterProductComposer';
import styles from './KioskSettingsSection.module.css';

/** Inputs for the group-administrator kiosk configuration. */
export interface KioskSettingsSectionProps {
  groupId: string;
  settings: GroupSettings;
}

interface PosterDraft {
  id: string | null;
  name: string;
  text: string;
  productIds: string[];
}

/**
 * Manages the master switch and reusable print poster templates.
 *
 * @param props - Authorized group and current persisted settings.
 * @returns Kiosk controls, a visual ordered poster editor, and PDF downloads.
 */
export function KioskSettingsSection({ groupId, settings }: KioskSettingsSectionProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const postersQuery = useQuery({ queryKey: ['kiosk-posters', groupId], queryFn: () => api.getKioskPosters(groupId), enabled: settings.kioskEnabled });
  const categoriesQuery = useQuery({ queryKey: ['categories', groupId], queryFn: () => api.getCategories(groupId), enabled: settings.kioskEnabled });
  const [draft, setDraft] = useState<PosterDraft | null>(null);
  const [deleteRequested, setDeleteRequested] = useState(false);
  const [notice, setNotice] = useState('');
  const posters = postersQuery.data ?? [];
  const selected = draft === null ? posters.find((poster) => poster.isDefault) ?? posters[0] : posters.find((poster) => poster.id === draft.id);
  const name = draft?.name ?? selected?.name ?? '';
  const text = draft?.text ?? selected?.text ?? '';
  const productIds = draft?.productIds ?? selected?.productIds ?? [];
  const isDefault = selected?.isDefault === true;
  const availableIds = new Set((categoriesQuery.data ?? []).filter((category) => category.active).flatMap((category) => category.products.filter((product) => product.active).map((product) => product.id)));
  const missingIds = productIds.filter((id) => !availableIds.has(id));
  const unsaved = selected ? name.trim() !== selected.name || text.trim() !== selected.text || JSON.stringify(productIds) !== JSON.stringify(selected.productIds) : true;
  const needsProducts = !isDefault && productIds.length === 0;
  const reservedName = !isDefault && name.trim().toLocaleLowerCase() === 'standard';

  const selectPoster = (poster?: KioskPoster) => {
    setDraft({ id: poster?.id ?? null, name: poster?.name ?? '', text: poster?.text ?? '', productIds: poster?.productIds ?? [] });
    setDeleteRequested(false);
    setNotice('');
  };
  const updateDraft = (changes: Partial<PosterDraft>) => {
    setDraft((current) => ({
      id: current ? current.id : selected?.id ?? null,
      name: current?.name ?? selected?.name ?? '',
      text: current?.text ?? selected?.text ?? '',
      productIds: current?.productIds ?? selected?.productIds ?? [],
      ...changes,
    }));
  };
  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => api.updateGroupSettings(groupId, { kioskEnabled: enabled }),
    onSuccess: (persisted) => {
      queryClient.setQueryData<GroupSettings>(['group-settings', groupId], persisted);
      queryClient.setQueryData<Session>(['session'], (session) => session ? {
        ...session,
        groups: session.groups.map((group) => group.id === groupId ? { ...group, kioskEnabled: persisted.kioskEnabled } : group),
      } : session);
    },
  });
  const saveMutation = useMutation({
    mutationFn: (input: KioskPosterInput) => selected
      ? api.updateKioskPoster(groupId, selected.id, selected.version, input)
      : api.createKioskPoster(groupId, input),
    onSuccess: async (poster) => {
      await queryClient.invalidateQueries({ queryKey: ['kiosk-posters', groupId] });
      selectPoster(poster);
      setNotice(t('kiosk.posterSaved'));
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (poster: KioskPoster) => api.deleteKioskPoster(groupId, poster.id, poster.version),
    onSuccess: async () => {
      selectPoster();
      await queryClient.invalidateQueries({ queryKey: ['kiosk-posters', groupId] });
      setNotice(t('kiosk.posterDeleted'));
    },
  });
  const pdfMutation = useMutation({
    mutationFn: (poster: KioskPoster) => api.getKioskPosterPdf(groupId, poster.id),
    onSuccess: (blob, poster) => downloadExportBlob(blob, `TeamTaler-${poster.name.replace(/[^\p{L}\p{N}-]+/gu, '_')}.pdf`),
  });
  return <section aria-labelledby="kiosk-settings-title" className={styles.section}>
    <div className={styles.card}>
      <div className={styles.settingRow}>
        <div><h3 id="kiosk-settings-title">{t('kiosk.settingsTitle')}</h3><p id="kiosk-settings-description">{t('kiosk.settingsDescription')}</p></div>
        <Toggle checked={settings.kioskEnabled === true} descriptionId="kiosk-settings-description" disabled={toggleMutation.isPending} label={t('kiosk.enable')} onChange={(enabled) => toggleMutation.mutate(enabled)} />
      </div>
      <p className={styles.notice}>{t(settings.kioskEnabled ? 'kiosk.enabledHint' : 'kiosk.disabledHint')}</p>
      {toggleMutation.isError ? <p role="alert">{toggleMutation.error.message}</p> : null}
    </div>
    {settings.kioskEnabled ? <div className={styles.card}>
      <div className={styles.heading}><div><h4>{t('kiosk.postersTitle')}</h4><p>{t('kiosk.postersDescription')}</p></div><Button leadingIcon={<Plus size={16} />} onClick={() => selectPoster()} size="small" variant="secondary">{t('kiosk.newPoster')}</Button></div>
      {postersQuery.isError || categoriesQuery.isError ? <p role="alert">{t('kiosk.postersLoadError')}</p> : null}
      <div aria-label={t('kiosk.postersTitle')} className={styles.posterList} role="group">
        {posters.map((poster) => <button aria-pressed={selected?.id === poster.id} className={selected?.id === poster.id ? styles.selected : ''} key={poster.id} onClick={() => selectPoster(poster)} type="button">{poster.name}</button>)}
      </div>
      {draft !== null || selected ? <form className={styles.form} onSubmit={(event) => { event.preventDefault(); if (!name.trim() || needsProducts || reservedName) return; saveMutation.mutate({ name: isDefault ? 'Standard' : name.trim(), text: text.trim(), productIds: isDefault ? [] : productIds }); }}>
        <label>{t('kiosk.posterName')}<input maxLength={120} onChange={(event) => updateDraft({ name: event.target.value })} readOnly={isDefault} required value={name} /></label>
        {reservedName ? <p className={styles.warning}>{t('kiosk.posterReservedName')}</p> : null}
        <label>{t('kiosk.posterText')}<textarea maxLength={2000} onChange={(event) => updateDraft({ text: event.target.value })} rows={3} value={text} /></label>
        {isDefault ? <p className={styles.standardHint}>{t('kiosk.standardPosterHint')}</p> : <><PosterProductComposer categories={categoriesQuery.data ?? []} onChange={(ids) => updateDraft({ productIds: ids })} productIds={productIds} />{needsProducts ? <p className={styles.saveHint}>{t('kiosk.posterNeedsProducts')}</p> : null}</>}
        {missingIds.length > 0 ? <p className={styles.warning} role="alert">{t('kiosk.removeUnavailableProducts')}</p> : null}
        {notice ? <p role="status">{notice}</p> : null}
        {saveMutation.isError ? <p role="alert">{saveMutation.error.message}</p> : null}
        {pdfMutation.isError ? <p role="alert">{pdfMutation.error.message}</p> : null}
        {deleteMutation.isError ? <p role="alert">{deleteMutation.error.message}</p> : null}
        {selected && unsaved ? <p className={styles.saveHint}>{t('kiosk.saveBeforePdf')}</p> : null}
        <div className={styles.actions}>
          {selected && !isDefault ? <Button leadingIcon={<Trash2 size={16} />} onClick={() => setDeleteRequested(true)} variant="danger">{t('common.delete')}</Button> : null}
          {selected ? <Button disabled={!settings.kioskEnabled || missingIds.length > 0 || needsProducts || reservedName || unsaved || pdfMutation.isPending} leadingIcon={<Download size={16} />} onClick={() => pdfMutation.mutate(selected)} variant="secondary">{t('kiosk.downloadPdf')}</Button> : null}
          <Button disabled={!name.trim() || needsProducts || reservedName || saveMutation.isPending} leadingIcon={<Save size={16} />} type="submit">{t('common.save')}</Button>
        </div>
      </form> : null}
      {deleteRequested && selected && !isDefault ? <div className={styles.deleteConfirm}><p>{t('kiosk.deletePosterConfirm', { name: selected.name })}</p><Button leadingIcon={<X size={16} />} onClick={() => setDeleteRequested(false)} variant="secondary">{t('common.cancel')}</Button><Button disabled={deleteMutation.isPending} leadingIcon={<Trash2 size={16} />} onClick={() => deleteMutation.mutate(selected)} variant="danger">{t('common.delete')}</Button></div> : null}
    </div> : null}
  </section>;
}
