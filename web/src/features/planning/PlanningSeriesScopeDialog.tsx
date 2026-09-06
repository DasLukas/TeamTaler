import Ban from 'lucide-react/dist/esm/icons/ban';
import CalendarClock from 'lucide-react/dist/esm/icons/calendar-clock';
import CalendarRange from 'lucide-react/dist/esm/icons/calendar-range';
import Edit3 from 'lucide-react/dist/esm/icons/edit-3';
import Repeat2 from 'lucide-react/dist/esm/icons/repeat-2';
import X from 'lucide-react/dist/esm/icons/x';
import { useTranslation } from 'react-i18next';
import type { PlanningSeriesScope } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import styles from './Planning.module.css';

interface PlanningSeriesScopeDialogProps {
  action: 'edit' | 'cancel';
  disabledScopes?: readonly PlanningSeriesScope[];
  errorMessage?: string;
  onClose: () => void;
  onConfirm: (scope: PlanningSeriesScope) => void;
  onScopeChange: (scope: PlanningSeriesScope) => void;
  open: boolean;
  pending?: boolean;
  recurrenceChanged?: boolean;
  restrictionMessage?: string;
  scope: PlanningSeriesScope;
}

const scopeIcons = {
  THIS: CalendarClock,
  THIS_AND_FOLLOWING: CalendarRange,
  ALL: Repeat2,
} as const;

/** Asks which part of an event series an edit or cancellation should affect. */
export function PlanningSeriesScopeDialog({ action, disabledScopes = [], errorMessage, onClose, onConfirm, onScopeChange, open, pending = false, recurrenceChanged = false, restrictionMessage, scope }: PlanningSeriesScopeDialogProps) {
  const { t } = useTranslation();
  const scopes: PlanningSeriesScope[] = ['THIS', 'THIS_AND_FOLLOWING', 'ALL'];

  return <Modal
    footer={<div className={styles.dialogActions}><Button disabled={pending} leadingIcon={<X size={17} />} onClick={onClose} variant="secondary">{t('common.cancel')}</Button><Button disabled={pending || disabledScopes.includes(scope)} leadingIcon={action === 'cancel' ? <Ban size={17} /> : <Edit3 size={17} />} onClick={() => onConfirm(scope)} variant={action === 'cancel' ? 'danger' : 'primary'}>{t(`planning.seriesScope.confirm.${action}`)}</Button></div>}
    onClose={() => { if (!pending) onClose(); }}
    open={open}
    title={t(`planning.seriesScope.title.${action}`)}
  >
    <div className={styles.seriesScopeDialog}>
      <p>{t(`planning.seriesScope.intro.${action}`)}</p>
      <fieldset className={styles.seriesScopeOptions}>
        <legend className={styles.srOnly}>{t('planning.seriesScope.legend')}</legend>
        {scopes.map((candidate) => {
          const Icon = scopeIcons[candidate];
          const disabled = disabledScopes.includes(candidate);
          return <label data-disabled={disabled || undefined} data-selected={scope === candidate || undefined} key={candidate}>
            <input checked={scope === candidate} disabled={disabled} name="planning-series-scope" onChange={() => onScopeChange(candidate)} type="radio" value={candidate} />
            <span aria-hidden="true" className={styles.seriesScopeIcon}><Icon size={19} /></span>
            <span><strong>{t(`planning.seriesScope.options.${candidate}.label`)}</strong><small>{t(`planning.seriesScope.options.${candidate}.description`)}</small></span>
          </label>;
        })}
      </fieldset>
      {action === 'edit' && recurrenceChanged ? <p className={styles.seriesScopeNote}>{t('planning.seriesScope.recurrenceOnlySeriesNote')}</p> : null}
      {restrictionMessage ? <p className={styles.seriesScopeRestriction} role="status">{restrictionMessage}</p> : null}
      <p className={styles.seriesScopeNote}>{t(`planning.seriesScope.exceptionNote.${action}`)}</p>
      {errorMessage ? <p className={styles.error} role="alert">{errorMessage}</p> : null}
    </div>
  </Modal>;
}
