import Check from 'lucide-react/dist/esm/icons/check';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { TextInput } from './FormField';
import styles from './SuggestionInput.module.css';

/** One free-text completion offered by a {@link SuggestionInput}. */
export interface SuggestionInputOption {
  /** Optional human-readable name shown before a distinct inserted value. */
  label?: string;
  /** Exact value inserted into the input when the option is selected. */
  value: string;
}

/** Properties accepted by the free-text input with app-rendered suggestions. */
export interface SuggestionInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'list' | 'onChange' | 'value'> {
  /** Receives every typed or selected value. */
  onChange: (value: string) => void;
  /** Ordered completion choices; arbitrary text remains valid. */
  options: readonly SuggestionInputOption[];
  /** Controlled input value. */
  value: string;
}

/**
 * Renders an editable, accessible combobox whose suggestion popup uses the
 * same dialog-safe visual language as the application's selection menus.
 *
 * @param props - Native text-input attributes, controlled value, suggestions,
 * and value-change callback.
 * @returns A free-text input with a keyboard-operable custom listbox.
 *
 * @example
 * <SuggestionInput id="reason" onChange={setReason} options={[{ value: 'Dues' }]} value={reason} />
 */
export function SuggestionInput({ onBlur, onChange, onFocus, options, value, ...inputProps }: SuggestionInputProps) {
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [portalTarget, setPortalTarget] = useState<Element | null>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' });
  const normalizedValue = value.trim().toLocaleLowerCase();
  const visibleOptions = normalizedValue
    ? options.filter((option) => option.value.toLocaleLowerCase().includes(normalizedValue) || option.label?.toLocaleLowerCase().includes(normalizedValue))
    : options;
  const menuOpen = open && visibleOptions.length > 0;

  const close = () => setOpen(false);
  const show = () => {
    if (inputProps.disabled || options.length === 0) return;
    if (open) return;
    setPortalTarget(inputRef.current?.closest('dialog') ?? document.body);
    setActiveIndex(0);
    setPanelStyle({ position: 'fixed', visibility: 'hidden' });
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = visibleOptions[index];
    if (!option) return;
    onChange(option.value);
    close();
    inputRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const input = inputRef.current;
    const panel = panelRef.current;
    if (!input || !panel) return;
    const inputRect = input.getBoundingClientRect();
    const boundary = input.closest('dialog');
    const boundaryRect = boundary?.getBoundingClientRect() ?? { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth };
    const margin = 12;
    const gap = 6;
    const roomBelow = boundaryRect.bottom - inputRect.bottom - gap - margin;
    const roomAbove = inputRect.top - boundaryRect.top - gap - margin;
    const openBelow = roomBelow >= 140 || roomBelow >= roomAbove;
    const maxHeight = Math.min(280, Math.max(110, openBelow ? roomBelow : roomAbove));
    const width = Math.min(Math.max(inputRect.width, 240), boundaryRect.width - margin * 2);
    const left = Math.min(Math.max(boundaryRect.left + margin, inputRect.left), boundaryRect.right - width - margin);
    const top = openBelow
      ? inputRect.bottom + gap
      : Math.max(boundaryRect.top + margin, inputRect.top - gap - Math.min(panel.scrollHeight, maxHeight));
    setPanelStyle({ position: 'fixed', top, left, width, maxHeight, visibility: 'visible' });
  }, [open, visibleOptions.length]);

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!inputRef.current?.contains(target) && !panelRef.current?.contains(target)) close();
    };
    const closeForLayoutChange = (event: Event) => {
      if (event.type === 'scroll' && event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      close();
    };
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', closeForLayoutChange);
    window.addEventListener('scroll', closeForLayoutChange, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', closeForLayoutChange);
      window.removeEventListener('scroll', closeForLayoutChange, true);
    };
  }, [open]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    inputProps.onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        show();
        return;
      }
      if (visibleOptions.length === 0) return;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((current) => (current + direction + visibleOptions.length) % visibleOptions.length);
    } else if (event.key === 'Enter' && open && visibleOptions.length > 0) {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      close();
    }
  };

  return (
    <div className={styles.root}>
      <TextInput
        {...inputProps}
        aria-activedescendant={menuOpen ? `${listboxId}-${activeIndex}` : undefined}
        aria-autocomplete="list"
        aria-controls={menuOpen ? listboxId : undefined}
        aria-expanded={menuOpen}
        autoComplete={inputProps.autoComplete ?? 'off'}
        onBlur={(event) => onBlur?.(event)}
        onChange={(event) => { onChange(event.target.value); setActiveIndex(0); show(); }}
        onFocus={(event) => { onFocus?.(event); show(); }}
        onKeyDown={handleKeyDown}
        ref={inputRef}
        role="combobox"
        value={value}
      />
      {menuOpen && portalTarget ? createPortal(
        <ul className={styles.menu} id={listboxId} ref={panelRef} role="listbox" style={panelStyle}>
          {visibleOptions.map((option, index) => (
            <li
              aria-label={option.label && option.label !== option.value ? `${option.label} ${option.value}` : undefined}
              aria-selected={option.value === value}
              className={`${styles.option} ${index === activeIndex ? styles.active : ''}`}
              id={`${listboxId}-${index}`}
              key={option.value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
              onPointerEnter={() => setActiveIndex(index)}
              role="option"
            >
              <span className={styles.optionText}>
                <strong>{option.label ?? option.value}</strong>
                {option.label && option.label !== option.value ? <small>{option.value}</small> : null}
              </span>
              {option.value === value ? <Check aria-hidden="true" size={17} /> : null}
            </li>
          ))}
        </ul>,
        portalTarget,
      ) : null}
    </div>
  );
}
