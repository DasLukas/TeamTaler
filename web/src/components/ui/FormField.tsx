import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import styles from './FormField.module.css';

/** Properties accepted by the form-field wrapper. */
export interface FieldProps {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  messageId?: string;
  children: ReactNode;
}

/**
 * Renders a label, hint, and validation wrapper for a form control.
 *
 * @param props - Label association, supporting copy, validation, and control.
 * @returns A complete form-field region.
 */
export function Field({ label, htmlFor, hint, error, messageId, children }: FieldProps) {
  return (
    <div className={styles.field}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <span className={styles.error} id={messageId} role="alert">{error}</span> : hint ? <span className={styles.hint} id={messageId}>{hint}</span> : null}
    </div>
  );
}

/**
 * Renders the TeamTaler text-input primitive.
 *
 * @param props - Native input attributes.
 * @returns A styled native input.
 */
export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={styles.control} {...props} />;
}

/**
 * Renders the TeamTaler select-input primitive.
 *
 * @param props - Native select attributes.
 * @returns A styled native select.
 */
export function SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={styles.control} {...props} />;
}
