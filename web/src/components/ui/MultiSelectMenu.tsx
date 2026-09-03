import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down';
import Search from 'lucide-react/dist/esm/icons/search';
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './MultiSelectMenu.module.css';

/** One value, label, and optional leading visual offered by a {@link MultiSelectMenu}. */
export interface MultiSelectMenuOption<Value extends string = string> {
  /** Clears every other selection when this option is selected. */
  exclusive?: boolean;
  groupLabel?: string;
  label: string;
  value: Value;
  visual?: ReactNode;
}

/** Properties accepted by the anchored multiple-value selection menu. */
export interface MultiSelectMenuProps<Value extends string = string> {
  allLabel: string;
  disabled?: boolean;
  emptyLabel: string;
  id: string;
  label: string;
  lockedValues?: readonly Value[];
  noResultsLabel?: string;
  onChange: (values: Value[]) => void;
  options: readonly MultiSelectMenuOption<Value>[];
  searchLabel?: string;
  /** Replaces the default comma-separated trigger summary. */
  summary?: ReactNode;
  values: readonly Value[];
}

/**
 * Renders a dialog-safe custom dropdown containing native checkbox choices.
 *
 * The menu is portalled into the nearest dialog, remains anchored to its trigger,
 * and preserves option order when multiple values are selected.
 *
 * @param props - Control identity, labels, ordered options, selection, and change callback.
 * @returns A keyboard-operable summary trigger and anchored checkbox menu.
 *
 * @example
 * <MultiSelectMenu id="categories" label="Categories" allLabel="All" emptyLabel="No categories" options={options} values={selected} onChange={setSelected} />
 */
export function MultiSelectMenu<Value extends string>({ allLabel, disabled = false, emptyLabel, id, label, lockedValues = [], noResultsLabel = emptyLabel, onChange, options, searchLabel, summary: summaryContent, values }: MultiSelectMenuProps<Value>) {
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [searchValue, setSearchValue] = useState('');
  const [portalTarget, setPortalTarget] = useState<Element | null>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' });
  const selectedValues = useMemo(() => new Set(values), [values]);
  const lockedValueSet = useMemo(() => new Set(lockedValues), [lockedValues]);
  const exclusiveValueSet = useMemo(() => new Set(options.filter((option) => option.exclusive).map((option) => option.value)), [options]);
  const normalizedSearch = searchValue.trim().toLocaleLowerCase();
  const visibleOptions = normalizedSearch
    ? options.filter((option) => option.label.toLocaleLowerCase().includes(normalizedSearch) || option.value.toLocaleLowerCase().includes(normalizedSearch))
    : options;
  const selectedOptions = options.filter((option) => selectedValues.has(option.value));
  const summary = selectedOptions.length === 0
    ? allLabel
    : selectedOptions.length <= 2
      ? selectedOptions.map((option) => option.label).join(', ')
      : `${selectedOptions.slice(0, 2).map((option) => option.label).join(', ')} +${selectedOptions.length - 2}`;

  const close = (restoreFocus = false) => {
    setOpen(false);
    setSearchValue('');
    if (restoreFocus) triggerRef.current?.focus();
  };
  const show = () => {
    setPortalTarget(triggerRef.current?.closest('dialog') ?? document.body);
    setPanelStyle({ position: 'fixed', visibility: 'hidden' });
    setOpen(true);
  };
  const toggle = (value: Value, checked: boolean) => {
    if (disabled || lockedValueSet.has(value)) return;
    const nextValues = new Set(selectedValues);
    if (!checked) nextValues.delete(value);
    else if (exclusiveValueSet.has(value)) {
      nextValues.clear();
      nextValues.add(value);
    } else {
      exclusiveValueSet.forEach((exclusiveValue) => nextValues.delete(exclusiveValue));
      nextValues.add(value);
    }
    onChange(options.filter((option) => nextValues.has(option.value)).map((option) => option.value));
  };

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const triggerRect = trigger.getBoundingClientRect();
    const boundary = trigger.closest('dialog');
    const boundaryRect = boundary?.getBoundingClientRect() ?? { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth };
    const margin = 12;
    const gap = 6;
    const roomBelow = boundaryRect.bottom - triggerRect.bottom - gap - margin;
    const roomAbove = triggerRect.top - boundaryRect.top - gap - margin;
    const openBelow = roomBelow >= 180 || roomBelow >= roomAbove;
    const maxHeight = Math.min(320, Math.max(120, openBelow ? roomBelow : roomAbove));
    const width = Math.min(Math.max(triggerRect.width, 280), boundaryRect.width - margin * 2);
    const left = Math.min(Math.max(boundaryRect.left + margin, triggerRect.left), boundaryRect.right - width - margin);
    const top = openBelow
      ? triggerRect.bottom + gap
      : Math.max(boundaryRect.top + margin, triggerRect.top - gap - Math.min(panel.scrollHeight, maxHeight));
    setPanelStyle({ position: 'fixed', top, left, width, maxHeight, visibility: 'visible' });
    panel.querySelector<HTMLInputElement>('input:checked, input')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !panelRef.current?.contains(target)) close();
    };
    const closeForEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close(true);
    };
    const closeForLayoutChange = (event: Event) => {
      if (event.type === 'scroll' && event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      close();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', closeForEscape);
    window.addEventListener('resize', closeForLayoutChange);
    window.addEventListener('scroll', closeForLayoutChange, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', closeForEscape);
      window.removeEventListener('resize', closeForLayoutChange);
      window.removeEventListener('scroll', closeForLayoutChange, true);
    };
  }, [open]);

  return (
    <div className={styles.root}>
      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={styles.trigger}
        disabled={disabled}
        id={id}
        onClick={() => { if (open) close(); else show(); }}
        ref={triggerRef}
        type="button"
      >
        <span className={styles.triggerSummary}>{summaryContent ?? summary}</span>
        <ChevronDown aria-hidden="true" className={styles.chevron} size={18} />
      </button>
      {open && portalTarget ? createPortal(
        <div aria-label={label} className={styles.menu} id={panelId} ref={panelRef} role="dialog" style={panelStyle}>
          {searchLabel && options.length > 0 ? <label className={styles.search}>
            <span className="sr-only">{searchLabel}</span>
            <Search aria-hidden="true" size={17} />
            <input aria-label={searchLabel} onChange={(event) => setSearchValue(event.target.value)} placeholder={searchLabel} type="search" value={searchValue} />
          </label> : null}
          {visibleOptions.length > 0 ? visibleOptions.map((option, index) => (
            <Fragment key={option.value}>
              {option.groupLabel && option.groupLabel !== visibleOptions[index - 1]?.groupLabel ? <p className={styles.groupLabel}>{option.groupLabel}</p> : null}
              <label className={styles.option} data-exclusive={option.exclusive || undefined}>
                <input checked={selectedValues.has(option.value)} disabled={disabled || lockedValueSet.has(option.value)} onChange={(event) => toggle(option.value, event.target.checked)} type="checkbox" />
                {option.visual ? <span aria-hidden="true" className={styles.visual}>{option.visual}</span> : null}
                <span className={styles.optionName}>{option.label}</span>
              </label>
            </Fragment>
          )) : <p className={styles.empty}>{options.length > 0 ? noResultsLabel : emptyLabel}</p>}
        </div>,
        portalTarget,
      ) : null}
    </div>
  );
}
