import Minus from 'lucide-react/dist/esm/icons/minus';
import Plus from 'lucide-react/dist/esm/icons/plus';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import type { Category, Product } from '@/api/types';
import { formatMoney } from '@/api/money';
import { IconButton } from '@/components/ui/IconButton';
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
  selectedProductIds?: readonly string[];
  productQuantities?: Readonly<Record<string, number>>;
  onProductSelect: (product: Product) => void;
  onProductDecrease?: (product: Product) => void;
  layout?: 'tiles' | 'rows';
}

/**
 * Renders category tabs and responsive product choices.
 *
 * @param props - Categories, selection state, callbacks, and layout mode.
 * @returns An accessible category tablist and product controls.
 */
export function ProductPicker({ categories, selectedCategoryId, onCategoryChange, selectedProductId, selectedProductIds = [], productQuantities = {}, onProductSelect, onProductDecrease, layout = 'tiles' }: ProductPickerProps) {
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
          const selected = product.id === selectedProductId || selectedProductIds.includes(product.id);
          const quantity = productQuantities[product.id] ?? 0;
          const priceLabel = product.pricingMode === 'FIXED' && product.price ? formatMoney(product.price) : t('booking.enterPrice');
          return (
            <div className={`${styles.product} ${selected ? styles.selectedProduct : ''}`} key={product.id}>
              <button aria-label={t(quantity > 0 ? 'booking.increaseProductAccessible' : 'booking.addProductAccessible', { name: product.name, price: priceLabel, count: quantity })} className={styles.productAction} onClick={() => onProductSelect(product)} type="button">
                {product.imageUrl ? <img alt="" src={product.imageUrl} /> : <span className={styles.fallback}>{product.name.slice(0, 1)}</span>}
                <span className={styles.name}>{product.name}</span>
                <span className={styles.price}>{priceLabel}</span>
                <span className={styles.check}>{quantity > 0 ? <strong aria-hidden="true">{quantity}×</strong> : <Plus aria-hidden="true" size={21} strokeWidth={2.3} />}</span>
              </button>
              {quantity > 0 && onProductDecrease ? (
                <IconButton
                  className={styles.decreaseControl}
                  label={quantity === 1 ? t('booking.removeProduct', { name: product.name }) : t('booking.decreaseProductQuantity', { name: product.name })}
                  onClick={() => onProductDecrease(product)}
                  variant="surface"
                >
                  {quantity === 1 ? <Trash2 aria-hidden="true" size={19} /> : <Minus aria-hidden="true" size={20} />}
                </IconButton>
              ) : null}
            </div>
          );
        })}
        {!activeCategory || activeCategory.products.length === 0 ? <p className={styles.empty}>{t('booking.emptyCategory')}</p> : null}
      </div>
    </div>
  );
}
