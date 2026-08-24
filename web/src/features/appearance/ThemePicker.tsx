import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { THEME_ID_VALUES, type ThemeId } from '@/api/types';
import styles from './ThemePicker.module.css';

/** Properties accepted by the reusable predefined-theme selector. */
export interface ThemePickerProps {
  defaultTheme?: ThemeId;
  disabled?: boolean;
  includeGroupDefault?: boolean;
  label: string;
  onChange: (theme: ThemeId | null) => void;
  value: ThemeId | null;
}

/**
 * Renders a keyboard-operable theme selector with representative palette previews.
 *
 * @param props - Current theme, optional inherited group theme, disabled state, and change callback.
 * @returns A native radio group for the predefined TeamTaler themes.
 */
export function ThemePicker({ defaultTheme = 'TEAMTALER', disabled = false, includeGroupDefault = false, label, onChange, value }: ThemePickerProps) {
  const { t } = useTranslation();
  const name = useId();
  const options: Array<{ inherited: boolean; label: string; previewTheme: ThemeId; value: ThemeId | null }> = THEME_ID_VALUES.map((theme) => {
    const inherited = includeGroupDefault && theme === defaultTheme;
    return {
      inherited,
      label: t(`appearance.themes.${theme}`),
      previewTheme: theme,
      value: inherited ? null : theme,
    };
  });

  return (
    <fieldset className={styles.picker} disabled={disabled}>
      <legend>{label}</legend>
      <div className={styles.options}>
        {options.map((option) => {
          const optionValue = option.value ?? '__GROUP_DEFAULT__';
          return (
            <label className={styles.option} key={optionValue}>
              <input
                aria-label={option.inherited ? t('appearance.groupDefaultAccessibleLabel', { theme: option.label }) : option.label}
                checked={value === option.value}
                name={name}
                onChange={() => onChange(option.value)}
                type="radio"
                value={optionValue}
              />
              <span className={styles.optionBody}>
                <span aria-hidden="true" className={styles.palette} data-preview-theme={option.previewTheme}>
                  <span /><span /><span />
                </span>
                <span className={styles.label}>
                  <span className={styles.name}>{option.label}</span>
                  {option.inherited ? <span className={styles.badge}>{t('appearance.groupDefaultBadge')}</span> : null}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
