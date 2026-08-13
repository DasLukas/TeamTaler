import Check from 'lucide-react/dist/esm/icons/check';
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down';
import Plus from 'lucide-react/dist/esm/icons/plus';
import UsersRound from 'lucide-react/dist/esm/icons/users-round';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { BookingTarget } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import styles from './MemberMultiSelect.module.css';

const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_BATCH_TARGETS = 100;

/** Properties accepted by the booking-target multi-select. */
export interface MemberMultiSelectProps {
  id: string;
  label: string;
  targets: readonly BookingTarget[];
  selectedIds: readonly string[];
  pendingGuestNames: readonly string[];
  onChange: (membershipIds: string[]) => void;
  onAddGuest: (displayName: string) => void;
  onRemoveGuest: (index: number) => void;
  canBookForGuests: boolean;
  disabled?: boolean;
  iconOnly?: boolean;
  overlayOnMobile?: boolean;
  placeholder: string;
}

/**
 * Renders an accessible booking-target picker with grouped members and guests.
 *
 * Temporary guest names remain local booking intent until the atomic batch request
 * succeeds; this component never creates a membership independently.
 *
 * @param props - Existing targets, pending guest names, labels, and callbacks.
 * @returns A summary or icon trigger, grouped choices, and optional guest input.
 */
export function MemberMultiSelect({
  id,
  label,
  targets,
  selectedIds,
  pendingGuestNames,
  onChange,
  onAddGuest,
  onRemoveGuest,
  canBookForGuests,
  disabled = false,
  iconOnly = false,
  overlayOnMobile = false,
  placeholder,
}: MemberMultiSelectProps) {
  const { t } = useTranslation();
  const compact = useMediaQuery('(max-width: 1023px)');
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [guestName, setGuestName] = useState('');
  const [guestNameError, setGuestNameError] = useState('');
  const [selectionError, setSelectionError] = useState('');
  const selected = new Set(selectedIds);
  const selectedTargets = targets.filter((target) => selected.has(target.membershipId));
  const regularTargets = targets.filter((target) => !target.isTemporaryGuest);
  const guestTargets = targets.filter((target) => target.isTemporaryGuest);
  const totalTargetCount = selectedIds.length + pendingGuestNames.length;
  const useSheet = overlayOnMobile && compact;

  useEffect(() => {
    if (!open || useSheet) return undefined;
    const closeForOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeForEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      document.getElementById(id)?.focus();
    };
    document.addEventListener('pointerdown', closeForOutsideClick);
    document.addEventListener('keydown', closeForEscape);
    return () => {
      document.removeEventListener('pointerdown', closeForOutsideClick);
      document.removeEventListener('keydown', closeForEscape);
    };
  }, [id, open, useSheet]);

  const update = (membershipId: string, checked: boolean) => {
    if (checked && totalTargetCount >= MAX_BATCH_TARGETS) {
      setSelectionError(t('booking.tooManyTargets'));
      return;
    }
    setSelectionError('');
    const next = new Set(selected);
    if (checked) next.add(membershipId);
    else next.delete(membershipId);
    onChange(targets.filter((target) => next.has(target.membershipId)).map((target) => target.membershipId));
  };

  const addGuest = () => {
    if (/\p{Cc}/u.test(guestName)) {
      setGuestNameError(t('booking.guestNameControlCharacters'));
      return;
    }
    const normalized = guestName.trim().replace(/\s+/g, ' ');
    if (!normalized) {
      setGuestNameError(t('booking.guestNameRequired'));
      return;
    }
    if ([...normalized].length > MAX_DISPLAY_NAME_LENGTH) {
      setGuestNameError(t('booking.guestNameTooLong'));
      return;
    }
    if (pendingGuestNames.some((name) => name.toLowerCase() === normalized.toLowerCase())) {
      setGuestNameError(t('booking.guestNameDuplicate'));
      return;
    }
    if (totalTargetCount >= MAX_BATCH_TARGETS) {
      setGuestNameError(t('booking.tooManyTargets'));
      return;
    }
    onAddGuest(normalized);
    setGuestName('');
    setGuestNameError('');
    setSelectionError('');
  };

  const handleGuestNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    addGuest();
  };

  const keepGuestCreatorVisible = (input: HTMLInputElement) => {
    if (!useSheet) return;
    requestAnimationFrame(() => input.scrollIntoView?.({ block: 'nearest' }));
  };

  const renderTarget = (target: BookingTarget) => (
    <label className={styles.option} key={target.membershipId}>
      <input checked={selected.has(target.membershipId)} disabled={!selected.has(target.membershipId) && totalTargetCount >= MAX_BATCH_TARGETS} onChange={(event) => update(target.membershipId, event.target.checked)} type="checkbox" />
      <span><strong>{target.displayName}</strong></span>
      {selected.has(target.membershipId) ? <Check aria-hidden="true" size={18} /> : null}
    </label>
  );

  const targetEditor = (
    <>
      {regularTargets.length > 0 ? <div aria-labelledby={`${id}-regular-members-label`} className={styles.group} role="group">
        <p className={styles.groupLabel} id={`${id}-regular-members-label`}>{t('booking.regularMembers')}</p>
        {regularTargets.map(renderTarget)}
      </div> : null}
      {guestTargets.length > 0 || pendingGuestNames.length > 0 || canBookForGuests ? <div aria-labelledby={`${id}-guests-label`} className={`${styles.group} ${regularTargets.length > 0 ? styles.guestGroup : ''}`} role="group">
        <p className={styles.groupLabel} id={`${id}-guests-label`}>{t('booking.guests')}</p>
        {guestTargets.map(renderTarget)}
        {pendingGuestNames.map((name, index) => (
          <label className={styles.option} key={`${name}-${index}`}>
            <input checked onChange={() => { setSelectionError(''); onRemoveGuest(index); }} type="checkbox" />
            <span><strong>{name}</strong><small>{t('booking.newGuest')}</small></span>
            <Check aria-hidden="true" size={18} />
          </label>
        ))}
        {canBookForGuests ? <div className={styles.guestCreator}>
          <label htmlFor={`${id}-guest-name`}>{t('booking.addGuest')}</label>
          <div className={styles.guestCreatorRow}>
            <TextInput
              aria-describedby={guestNameError ? `${id}-guest-name-error` : undefined}
              aria-invalid={guestNameError ? 'true' : undefined}
              autoComplete="off"
              id={`${id}-guest-name`}
              onChange={(event) => { setGuestName(event.target.value); setGuestNameError(''); }}
              onFocus={(event) => keepGuestCreatorVisible(event.currentTarget)}
              onKeyDown={handleGuestNameKeyDown}
              placeholder={t('booking.guestNamePlaceholder')}
              value={guestName}
            />
            <Button aria-label={t('booking.addGuestAction')} disabled={!guestName.trim() || totalTargetCount >= MAX_BATCH_TARGETS} onClick={addGuest} size="small" variant="secondary"><Plus size={17} /></Button>
          </div>
          {guestNameError ? <p className={styles.guestError} id={`${id}-guest-name-error`} role="alert">{guestNameError}</p> : null}
        </div> : null}
      </div> : null}
      {selectionError ? <p className={styles.guestError} role="alert">{selectionError}</p> : null}
    </>
  );

  return (
    <div className={`${styles.picker} ${iconOnly ? styles.iconPicker : ''}`} ref={rootRef}>
      <button
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`${styles.trigger} ${iconOnly ? styles.iconTrigger : ''}`}
        disabled={disabled}
        id={id}
        onClick={() => setOpen((current) => !current)}
        title={label}
        type="button"
      >
        {iconOnly ? (
          <>
            <UsersRound aria-hidden="true" size={36} strokeWidth={1.9} />
            <span aria-hidden="true" className={styles.countBadge}>{totalTargetCount}</span>
          </>
        ) : (
          <>
            <span className={styles.summary}>
              {selectedTargets.length === 0 && pendingGuestNames.length === 0 ? <span className={styles.placeholder}>{placeholder}</span> : null}
              {selectedTargets.slice(0, 2).map((target) => <span className={styles.chip} key={target.membershipId}>{target.displayName}</span>)}
              {selectedTargets.length < 2 ? pendingGuestNames.slice(0, 2 - selectedTargets.length).map((name, index) => <span className={`${styles.chip} ${styles.pendingChip}`} key={`${name}-${index}`}>{name}</span>) : null}
              {selectedTargets.length + pendingGuestNames.length > 2 ? <span className={styles.overflow}>+{selectedTargets.length + pendingGuestNames.length - 2}</span> : null}
            </span>
            <ChevronDown aria-hidden="true" className={styles.chevron} size={18} />
          </>
        )}
      </button>
      {open && useSheet ? (
        <Modal className={styles.sheetDialog} onClose={() => setOpen(false)} open title={t('booking.selectRecipients')} variant="sheet">
          <div className={styles.sheetContent}>{targetEditor}</div>
        </Modal>
      ) : null}
      {open && !useSheet ? <div aria-label={label} className={styles.menu} role="dialog">{targetEditor}</div> : null}
    </div>
  );
}
