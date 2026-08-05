import Check from 'lucide-react/dist/esm/icons/check';
import type { Category, Product } from '@/api/types';
import { formatMoney } from '@/api/money';
import { CategoryIcon } from '@/features/shared/CategoryIcon';
import { useTranslation } from 'react-i18next';
import { getBookableCategories } from './bookable';
import styles from './ProductPicker.module.css';

/** Properties accepted by the category and product picker. */
export interface ProductPickerProps {
  categories: Category[];
  selectedCategoryId: string;
  onCategoryChange: (categoryId: string) => void;
  selectedProductId?: string;
  onProductSelect: (product: Product) => void;
  layout?: 'tiles' | 'rows';
}

/**
 * Renders category tabs and responsive product choices.
 *
 * @param props - Categories, selection state, callbacks, and layout mode.
 * @returns An accessible category tablist and product controls.
 */
export function ProductPicker({ categories, selectedCategoryId, onCategoryChange, selectedProductId, onProductSelect, layout = 'tiles' }: ProductPickerProps) {
  const { t } = useTranslation();
  const bookableCategories = getBookableCategories(categories);
  const activeCategory = bookableCategories.find((category) => category.id === selectedCategoryId) ?? bookableCategories[0];
  return (
    <div className={styles.picker}>
      <div aria-label={t('booking.categoryTabs')} className={styles.tabs} role="tablist">
        {bookableCategories.map((category) => {
          const selected = category.id === activeCategory?.id;
          return (
            <button aria-selected={selected} className={selected ? styles.activeTab : ''} key={category.id} onClick={() => onCategoryChange(category.id)} role="tab" type="button">
              <CategoryIcon icon={category.icon} size={23} /> {category.name}
            </button>
          );
        })}
      </div>
      <div className={`${styles.products} ${styles[layout]}`} role="tabpanel">
        {activeCategory?.products.map((product) => {
          const selected = product.id === selectedProductId;
          return (
            <button aria-pressed={selected} className={`${styles.product} ${selected ? styles.selectedProduct : ''}`} key={product.id} onClick={() => onProductSelect(product)} type="button">
              {product.imageUrl ? <img alt="" src={product.imageUrl} /> : <span className={styles.fallback}>{product.name.slice(0, 1)}</span>}
              <span className={styles.name}>{product.name}</span>
              <span className={styles.price}>{product.pricingMode === 'FIXED' && product.price ? formatMoney(product.price) : t('booking.enterPrice')}</span>
              {selected ? <span className={styles.check}><Check aria-hidden="true" size={21} strokeWidth={2.3} /></span> : null}
            </button>
          );
        })}
        {!activeCategory || activeCategory.products.length === 0 ? <p className={styles.empty}>{t('booking.emptyCategory')}</p> : null}
      </div>
    </div>
  );
}
