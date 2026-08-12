import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import type { Role } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { RoleSelectionList } from './RoleSelectionList';
import { roleDisplayName } from './roleDisplayName';
import styles from './RoleAssignmentPicker.module.css';

/** Properties accepted by the versioned member or invitation role picker. */
export interface RoleAssignmentPickerProps {
  subjectName: string;
  roles: readonly Role[];
  roleIds: readonly string[];
  onApply: (roleIds: string[]) => Promise<void>;
  canAssignRoles?: boolean;
  canManageGroup?: boolean;
  lockedRoleIds?: readonly string[];
  disabled?: boolean;
}

function sameRoleIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((roleId) => rightSet.has(roleId));
}

function assignmentError(error: unknown, conflict: string, protectedConflict: string): string {
  if (error instanceof ApiError && error.problem.status === 412) return conflict;
  if (error instanceof ApiError && error.problem.status === 409) return protectedConflict;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Summarizes assigned roles for the compact table trigger.
 *
 * @param roles - Available group roles.
 * @param roleIds - Assigned role identifiers.
 * @returns At most two role labels plus an overflow count.
 */
function summarizeAssignedRoles(roles: readonly Role[], roleIds: readonly string[]): { labels: string[]; overflow: number } {
  const selected = new Set(roleIds);
  const assigned = roles.filter((role) => selected.has(role.id));
  return { labels: assigned.slice(0, 2).map(roleDisplayName), overflow: Math.max(0, assigned.length - 2) };
}

/**
 * Renders an anchored desktop multi-select and a compact-screen role sheet.
 * Draft changes are persisted only after explicit confirmation.
 *
 * @param props - Subject, roles, authorization, locks, and async save callback.
 * @returns A compact role summary trigger and its responsive editor.
 */
export function RoleAssignmentPicker({
  subjectName,
  roles,
  roleIds,
  onApply,
  canAssignRoles = false,
  canManageGroup = false,
  lockedRoleIds = [],
  disabled = false,
}: RoleAssignmentPickerProps) {
  const { t } = useTranslation();
  const compact = useMediaQuery('(max-width: 767px)');
  const dialogId = useId();
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [draftRoleIds, setDraftRoleIds] = useState<string[]>(() => [...roleIds]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' });
  const summary = useMemo(() => summarizeAssignedRoles(roles, roleIds), [roleIds, roles]);
  const title = t('roleManagement.rolesFor', { name: subjectName });
  const changed = !sameRoleIds(draftRoleIds, roleIds);
  const hasRole = draftRoleIds.length > 0;

  useLayoutEffect(() => {
    if (!open || compact) return;
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const rect = trigger.getBoundingClientRect();
    const margin = 12;
    const gap = 8;
    const width = Math.min(380, window.innerWidth - margin * 2);
    const height = Math.min(panel.scrollHeight, window.innerHeight - margin * 2);
    const roomBelow = window.innerHeight - rect.bottom - gap - margin;
    const roomAbove = rect.top - gap - margin;
    const top = roomBelow >= Math.min(height, 320) || roomBelow >= roomAbove
      ? Math.min(rect.bottom + gap, window.innerHeight - height - margin)
      : Math.max(margin, rect.top - height - gap);
    const left = Math.min(Math.max(margin, rect.right - width), window.innerWidth - width - margin);
    setPanelStyle({ position: 'fixed', top, left, width, visibility: 'visible' });
    panel.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)')?.focus();
  }, [compact, open]);

  useEffect(() => {
    if (!open || compact) return undefined;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const closeForResize = () => setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', closeForResize);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('resize', closeForResize);
    };
  }, [compact, open]);

  const close = () => {
    if (pending) return;
    setOpen(false);
    setDraftRoleIds([...roleIds]);
    setError('');
  };
  const apply = async () => {
    if (!changed || pending) return;
    setPending(true);
    setError('');
    try {
      await onApply(draftRoleIds);
      setOpen(false);
      triggerRef.current?.focus();
    } catch (caught) {
      setError(assignmentError(caught, t('roleManagement.assignmentConflict'), t('roleManagement.assignmentProtectedConflict')));
    } finally {
      setPending(false);
    }
  };
  const editor = (
    <div className={styles.editor}>
      <div className={styles.listViewport}>
        <RoleSelectionList
          canManageGroup={canManageGroup}
          canAssignRoles={canAssignRoles}
          disabled={pending}
          hideLegend
          label={title}
          lockedRoleIds={lockedRoleIds}
          onChange={setDraftRoleIds}
          roleIds={draftRoleIds}
          roles={roles}
        />
      </div>
      <div className={styles.footer}>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <div className={styles.actions}>
          <Button disabled={pending} onClick={close} size="small" variant="secondary">{t('common.cancel')}</Button>
          <Button disabled={!changed || !hasRole || pending} onClick={() => void apply()} size="small">{pending ? t('roleManagement.saving') : t('roleManagement.applyAssignment')}</Button>
        </div>
      </div>
    </div>
  );
  let overlay: ReactNode = null;
  if (open && compact) {
    overlay = <Modal className={styles.sheetDialog} onClose={close} open title={title} variant="sheet"><div className={styles.sheetContent}>{editor}</div></Modal>;
  } else if (open) {
    overlay = createPortal(
      <div aria-labelledby={titleId} className={styles.panel} id={dialogId} ref={panelRef} role="dialog" style={panelStyle}>
        <header className={styles.panelHeader}><h3 id={titleId}>{title}</h3><p>{t('roleManagement.multiRoleHint')}</p></header>
        {editor}
      </div>,
      document.body,
    );
  }

  return (
    <div className={styles.picker}>
      <button
        aria-controls={open && !compact ? dialogId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t('roleManagement.editRolesFor', { name: subjectName })}
        className={styles.trigger}
        disabled={disabled || pending}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          setDraftRoleIds([...roleIds]);
          setError('');
          setPanelStyle({ position: 'fixed', visibility: 'hidden' });
          setOpen(true);
        }}
        ref={triggerRef}
        type="button"
      >
        <span className={styles.summary}>
          {summary.labels.map((label) => <span className={styles.chip} key={label}>{label}</span>)}
          {summary.overflow > 0 ? <span className={styles.overflow}>+{summary.overflow}</span> : null}
        </span>
        <ChevronDown aria-hidden="true" className={styles.chevron} size={17} />
      </button>
      {overlay}
    </div>
  );
}
