import Check from 'lucide-react/dist/esm/icons/check';
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './SelectMenu.module.css';

/** One value and visible label offered by a {@link SelectMenu}. */
export interface SelectMenuOption<Value extends string = string> {
  value: Value;
  label: string;
}

/** Properties accepted by the anchored single-value selection menu. */
export interface SelectMenuProps<Value extends string = string> {
  ariaDescribedBy?: string;
  ariaLabel?: string;
  className?: string;
  id: string;
  menuMinWidth?: number;
  value: Value;
  options: readonly SelectMenuOption<Value>[];
  onChange: (value: Value) => void;
  disabled?: boolean;
  renderOption?: (option: SelectMenuOption<Value>) => ReactNode;
  renderValue?: (option: SelectMenuOption<Value>) => ReactNode;
  title?: string;
}

/**
 * Renders an accessible single-value menu that stays anchored inside its
 * containing dialog and scrolls internally when vertical space is limited.
 *
 * @param props - Control identity, selected value, choices, change callback,
 * and optional disabled state.
 * @returns A keyboard-operable combobox trigger and anchored listbox.
 */
export function SelectMenu<Value extends string>({ ariaDescribedBy, ariaLabel, className = '', id, menuMinWidth = 0, value, options, onChange, disabled = false, renderOption, renderValue, title }: SelectMenuProps<Value>) {
  const listboxId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [portalTarget, setPortalTarget] = useState<Element | null>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' });
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selectedOption = options[selectedIndex];

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    close(true);
  };
  const show = () => {
    if (disabled || options.length === 0) return;
    setPortalTarget(triggerRef.current?.closest('dialog') ?? document.body);
    setActiveIndex(selectedIndex);
    setPanelStyle({ position: 'fixed', visibility: 'hidden' });
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const boundary = trigger?.closest('dialog');
    if (!trigger) return;
    const triggerRect = trigger.getBoundingClientRect();
    const boundaryRect = boundary?.getBoundingClientRect() ?? { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth };
    const margin = 12;
    const gap = 6;
    const roomBelow = boundaryRect.bottom - triggerRect.bottom - gap - margin;
    const roomAbove = triggerRect.top - boundaryRect.top - gap - margin;
    const openBelow = roomBelow >= 180 || roomBelow >= roomAbove;
    const availableHeight = Math.max(120, openBelow ? roomBelow : roomAbove);
    const maxHeight = Math.min(280, availableHeight);
    const width = Math.min(Math.max(triggerRect.width, menuMinWidth), boundaryRect.width - margin * 2);
    const left = Math.min(
      Math.max(boundaryRect.left + margin, triggerRect.left),
      boundaryRect.right - width - margin,
    );
    const top = openBelow
      ? triggerRect.bottom + gap
      : Math.max(boundaryRect.top + margin, triggerRect.top - gap - Math.min(panelRef.current?.scrollHeight ?? maxHeight, maxHeight));
    setPanelStyle({ position: 'fixed', top, left, width, maxHeight, visibility: 'visible' });
  }, [menuMinWidth, open]);

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !panelRef.current?.contains(target)) close();
    };
    const closeForLayoutChange = () => close();
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', closeForLayoutChange);
    window.addEventListener('scroll', closeForLayoutChange, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', closeForLayoutChange);
      window.removeEventListener('scroll', closeForLayoutChange, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const option = panel?.children.item(activeIndex) as HTMLElement | null;
    if (!panel || !option) return;
    const optionTop = option.offsetTop;
    const optionBottom = optionTop + option.offsetHeight;
    if (optionTop < panel.scrollTop) panel.scrollTop = optionTop;
    else if (optionBottom > panel.scrollTop + panel.clientHeight) panel.scrollTop = optionBottom - panel.clientHeight;
  }, [activeIndex, open, panelStyle]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        show();
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((current) => (current + direction + options.length) % options.length);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? 0 : options.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') {
      close();
    }
  };

  return (
    <div className={`${styles.root} ${className}`}>
      <button
        aria-activedescendant={open ? `${listboxId}-${activeIndex}` : undefined}
        aria-controls={open ? listboxId : undefined}
        aria-describedby={ariaDescribedBy}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className={styles.trigger}
        disabled={disabled}
        id={id}
        onClick={() => { if (open) close(); else show(); }}
        onKeyDown={handleKeyDown}
        ref={triggerRef}
        role="combobox"
        title={title}
        type="button"
      >
        <span className={styles.value}>{selectedOption ? (renderValue?.(selectedOption) ?? selectedOption.label) : ''}</span>
        <ChevronDown aria-hidden="true" className={styles.chevron} size={18} />
      </button>
      {open && portalTarget ? createPortal(
        <ul aria-label={ariaLabel} className={styles.menu} id={listboxId} ref={panelRef} role="listbox" style={panelStyle}>
          {options.map((option, index) => (
            <li
              aria-selected={option.value === value}
              className={`${styles.option} ${index === activeIndex ? styles.active : ''}`}
              id={`${listboxId}-${index}`}
              key={option.value}
              onClick={() => choose(index)}
              onPointerEnter={() => setActiveIndex(index)}
              role="option"
            >
              <span>{renderOption?.(option) ?? option.label}</span>
              {option.value === value ? <Check aria-hidden="true" size={17} /> : null}
            </li>
          ))}
        </ul>,
        portalTarget,
      ) : null}
    </div>
  );
}
