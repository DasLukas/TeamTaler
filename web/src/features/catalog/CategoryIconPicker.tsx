import { useTranslation } from 'react-i18next';
import { CATEGORY_ICON_VALUES, type CategoryIcon as CategoryIconName } from '@/api/types';
import { CategoryIcon } from '@/features/shared/CategoryIcon';
import styles from './CategoryIconPicker.module.css';

/** Properties accepted by the catalog category icon selection control. */
export interface CategoryIconPickerProps {
  value: CategoryIconName;
  onChange: (icon: CategoryIconName) => void;
}

/**
 * Renders an accessible single-choice grid for all supported category icons.
 *
 * @param props - Current icon and callback invoked with a newly selected icon.
 * @returns A labelled icon selection fieldset.
 */
export function CategoryIconPicker({ value, onChange }: CategoryIconPickerProps) {
  const { t } = useTranslation();
  return (
    <fieldset className={styles.picker}>
      <legend>{t('catalog.categoryIcon')}</legend>
      <div>
        {CATEGORY_ICON_VALUES.map((icon) => {
          const label = t(`catalog.categoryIcons.${icon}`);
          return (
            <button aria-label={label} aria-pressed={value === icon} key={icon} onClick={() => onChange(icon)} type="button">
              <CategoryIcon icon={icon} size={22} />
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
