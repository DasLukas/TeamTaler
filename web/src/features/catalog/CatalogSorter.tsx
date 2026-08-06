import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import GripVertical from 'lucide-react/dist/esm/icons/grip-vertical';
import ImagePlus from 'lucide-react/dist/esm/icons/image-plus';
import Pencil from 'lucide-react/dist/esm/icons/pencil';
import Plus from 'lucide-react/dist/esm/icons/plus';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '@/api/money';
import type { Category, Product } from '@/api/types';
import { IconButton } from '@/components/ui/IconButton';
import { CategoryIcon } from '@/features/shared/CategoryIcon';
import { categorySortableId, moveCatalogItem, productSortableId } from './catalogOrder';
import styles from './CatalogPanel.module.css';

interface SortableProductProps {
  disabled: boolean;
  product: Product;
  onEdit: (product: Product) => void;
}

/** Renders one product card as a pointer- and keyboard-sortable item. */
function SortableProduct({ disabled, product, onEdit }: SortableProductProps) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: productSortableId(product.id),
    disabled,
  });
  return (
    <article
      className={`${!product.active ? styles.archived : ''} ${styles.sortable} ${isDragging ? styles.dragging : ''}`}
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {product.imageUrl ? <img alt="" src={product.imageUrl} /> : <span className={styles.imageFallback}><ImagePlus size={26} /></span>}
      <div><strong>{product.name}</strong><span>{product.pricingMode === 'FIXED' && product.price ? formatMoney(product.price) : t('catalog.userDefinedPrice')}</span></div>
      <small>{product.active ? t('common.active') : t('common.archived')}</small>
      <IconButton className={styles.productEdit} label={t('catalog.editProduct', { name: product.name })} onClick={() => onEdit(product)} variant="surface"><Pencil size={16} /></IconButton>
      <IconButton
        {...attributes}
        {...listeners}
        className={`${styles.dragHandle} ${styles.productDragHandle}`}
        disabled={disabled}
        label={t('catalog.moveProduct', { name: product.name })}
        variant="surface"
      ><GripVertical size={18} /></IconButton>
    </article>
  );
}

interface SortableCategoryProps {
  category: Category;
  disabled: boolean;
  onAddProduct: (categoryId: string) => void;
  onEditCategory: (category: Category) => void;
  onEditProduct: (product: Product) => void;
}

/** Renders one category and its independently sortable product collection. */
function SortableCategory({ category, disabled, onAddProduct, onEditCategory, onEditProduct }: SortableCategoryProps) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: categorySortableId(category.id),
    disabled,
  });
  return (
    <section
      className={`${styles.category} ${styles.sortable} ${!category.active ? styles.archived : ''} ${isDragging ? styles.dragging : ''}`}
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <header>
        <IconButton
          {...attributes}
          {...listeners}
          className={styles.dragHandle}
          disabled={disabled}
          label={t('catalog.moveCategory', { name: category.name })}
          variant="surface"
        ><GripVertical size={20} /></IconButton>
        <span><CategoryIcon icon={category.icon} size={22} /></span>
        <div><h3>{category.name}</h3><p>{t('catalog.productCount', { count: category.products.length })} · {category.active ? t('common.active') : t('common.archived')}</p></div>
        <IconButton className={styles.categoryEdit} label={t('catalog.editCategory', { name: category.name })} onClick={() => onEditCategory(category)} variant="surface"><Pencil size={17} /></IconButton>
      </header>
      {category.products.length === 0 ? <p className={styles.emptyProducts}>{t('catalog.emptyProducts')}</p> : (
        <SortableContext items={category.products.map((product) => productSortableId(product.id))} strategy={rectSortingStrategy}>
          <div className={styles.products}>{category.products.map((product) => (
            <SortableProduct disabled={disabled} key={product.id} onEdit={onEditProduct} product={product} />
          ))}</div>
        </SortableContext>
      )}
      <IconButton className={`${styles.roundAdd} ${styles.productAdd}`} label={t('catalog.addProductToCategory', { name: category.name })} onClick={() => onAddProduct(category.id)} variant="surface"><Plus size={22} /></IconButton>
    </section>
  );
}

/** Properties required by the reusable catalog drag-and-drop surface. */
export interface CatalogSorterProps {
  categories: Category[];
  disabled: boolean;
  onAddCategory: () => void;
  onAddProduct: (categoryId: string) => void;
  onEditCategory: (category: Category) => void;
  onEditProduct: (product: Product) => void;
  onReorder: (categories: Category[]) => void;
}

/**
 * Renders nested category and product sortables with pointer, touch, and
 * keyboard controls. Products remain constrained to their owning category.
 *
 * @param props - Catalog data, mutation state, and editor callbacks.
 * @returns The complete interactive catalog order surface.
 */
export function CatalogSorter({ categories, disabled, onAddCategory, onAddProduct, onEditCategory, onEditProduct, onReorder }: CatalogSorterProps) {
  const { t } = useTranslation();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const labelFor = (sortableId: string) => {
    if (sortableId.startsWith('category:')) return categories.find((category) => categorySortableId(category.id) === sortableId)?.name ?? sortableId;
    return categories.flatMap((category) => category.products).find((product) => productSortableId(product.id) === sortableId)?.name ?? sortableId;
  };
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const reordered = moveCatalogItem(categories, String(active.id), String(over.id));
    if (reordered) onReorder(reordered);
  };
  return (
    <DndContext
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => t('catalog.dragStarted', { name: labelFor(String(active.id)) }),
          onDragOver: ({ active, over }) => over ? t('catalog.dragOver', { name: labelFor(String(active.id)), target: labelFor(String(over.id)) }) : undefined,
          onDragEnd: ({ active, over }) => over && moveCatalogItem(categories, String(active.id), String(over.id))
            ? t('catalog.dragCompleted', { name: labelFor(String(active.id)), target: labelFor(String(over.id)) })
            : t('catalog.dragCanceled', { name: labelFor(String(active.id)) }),
          onDragCancel: ({ active }) => t('catalog.dragCanceled', { name: labelFor(String(active.id)) }),
        },
        screenReaderInstructions: { draggable: t('catalog.dragInstructions') },
      }}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
      sensors={sensors}
    >
      <SortableContext items={categories.map((category) => categorySortableId(category.id))} strategy={verticalListSortingStrategy}>
        <div className={styles.categories}>
          {categories.map((category) => (
            <SortableCategory
              category={category}
              disabled={disabled}
              key={category.id}
              onAddProduct={onAddProduct}
              onEditCategory={onEditCategory}
              onEditProduct={onEditProduct}
            />
          ))}
          <IconButton className={`${styles.roundAdd} ${styles.categoryAdd}`} label={t('catalog.addCategoryAfterList')} onClick={onAddCategory} variant="surface"><Plus size={24} /></IconButton>
        </div>
      </SortableContext>
    </DndContext>
  );
}
