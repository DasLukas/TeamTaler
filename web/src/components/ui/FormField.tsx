import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import styles from './FormField.module.css';

/** Properties accepted by the form-field wrapper. */
export interface FieldProps {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  messageId?: string;
  required?: boolean;
  children: ReactNode;
}

/**
 * Renders a label, hint, and validation wrapper for a form control.
 *
 * @param props - Label association, required-state marker, supporting copy, validation, and control.
 * @returns A complete form-field region.
 */
export function Field({ label, htmlFor, hint, error, messageId, required = false, children }: FieldProps) {
  return (
    <div className={styles.field}>
      <label htmlFor={htmlFor}>{label}{required ? <span aria-hidden="true" className={styles.requiredMarker}> *</span> : null}</label>
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
export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput(props, ref) {
  return <input className={styles.control} ref={ref} {...props} />;
});

/**
 * Renders the TeamTaler multiline text-input primitive.
 *
 * @param props - Native textarea attributes.
 * @returns A styled native textarea.
 */
export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${styles.control} ${styles.textarea}`} {...props} />;
}
