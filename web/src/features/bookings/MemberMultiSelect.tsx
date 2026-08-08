import Check from 'lucide-react/dist/esm/icons/check';
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down';
import { useEffect, useRef, useState } from 'react';
import type { Membership } from '@/api/types';
import styles from './MemberMultiSelect.module.css';

/** Properties accepted by the booking-target multi-select. */
export interface MemberMultiSelectProps {
  id: string;
  label: string;
  members: readonly Membership[];
  selectedIds: readonly string[];
  onChange: (membershipIds: string[]) => void;
  disabled?: boolean;
  placeholder: string;
}

/**
 * Renders an accessible multi-choice dropdown for booking targets.
 *
 * @param props - Available memberships, selected IDs, labels, and change callback.
 * @returns A compact summary trigger and checkbox menu.
 */
export function MemberMultiSelect({ id, label, members, selectedIds, onChange, disabled = false, placeholder }: MemberMultiSelectProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selected = new Set(selectedIds);
  const selectedMembers = members.filter((member) => selected.has(member.id));

  useEffect(() => {
    if (!open) return undefined;
    const closeForOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeForEscape = (event: KeyboardEvent) => {
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
  }, [id, open]);

  const update = (membershipId: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(membershipId);
    else next.delete(membershipId);
    onChange(members.filter((member) => next.has(member.id)).map((member) => member.id));
  };

  return (
    <div className={styles.picker} ref={rootRef}>
      <button
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={styles.trigger}
        disabled={disabled}
        id={id}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className={styles.summary}>
          {selectedMembers.length === 0 ? <span className={styles.placeholder}>{placeholder}</span> : null}
          {selectedMembers.slice(0, 2).map((member) => <span className={styles.chip} key={member.id}>{member.displayName}</span>)}
          {selectedMembers.length > 2 ? <span className={styles.overflow}>+{selectedMembers.length - 2}</span> : null}
        </span>
        <ChevronDown aria-hidden="true" className={styles.chevron} size={18} />
      </button>
      {open ? (
        <div aria-label={label} className={styles.menu} role="dialog">
          {members.map((member) => (
            <label className={styles.option} key={member.id}>
              <input checked={selected.has(member.id)} onChange={(event) => update(member.id, event.target.checked)} type="checkbox" />
              <span><strong>{member.displayName}</strong><small>{member.email}</small></span>
              {selected.has(member.id) ? <Check aria-hidden="true" size={18} /> : null}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
