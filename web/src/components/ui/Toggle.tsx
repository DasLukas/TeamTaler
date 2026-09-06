import styles from './Toggle.module.css';

/** Properties accepted by the accessible switch control. */
export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  descriptionId?: string;
  disabled?: boolean;
}

/**
 * Renders an accessible switch for role and permission assignments.
 *
 * @param props - Checked state, change callback, accessible label, supporting-copy association, and disabled state.
 * @returns A button exposing native switch semantics.
 */
export function Toggle({ checked, onChange, label, descriptionId, disabled = false }: ToggleProps) {
  return (
    <button
      aria-checked={checked}
      aria-describedby={descriptionId}
      aria-label={label}
      className={`${styles.toggle} ${checked ? styles.checked : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span className={styles.thumb} />
    </button>
  );
}
