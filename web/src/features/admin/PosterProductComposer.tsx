import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import GripVertical from 'lucide-react/dist/esm/icons/grip-vertical';
import Plus from 'lucide-react/dist/esm/icons/plus';
import Search from 'lucide-react/dist/esm/icons/search';
import X from 'lucide-react/dist/esm/icons/x';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '@/api/money';
import type { Category, Product } from '@/api/types';
import { IconButton } from '@/components/ui/IconButton';
import { ManagedImageFrame } from '@/components/ui/ManagedImage';
import styles from './PosterProductComposer.module.css';

const MAX_POSTER_PRODUCTS = 100;

/** Properties of the reusable visual poster product editor. */
export interface PosterProductComposerProps {
  categories: Category[];
  productIds: string[];
  onChange: (ids: string[]) => void;
}

interface PosterProductCardProps {
  id: string;
  product?: Product;
  categoryActive: boolean;
  onRemove: (id: string) => void;
}

/**
 * Renders one sortable poster product tile with catalog-style media and actions.
 *
 * @param props - Product data, availability, and removal callback.
 * @returns An image-led tile with keyboard-accessible drag and remove controls.
 */
function PosterProductCard({ id, product, categoryActive, onRemove }: PosterProductCardProps) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const available = Boolean(product?.active && categoryActive);
  const name = product?.name ?? t('kiosk.deletedProduct');
  const price = product?.pricingMode === 'FIXED' && product.price ? formatMoney(product.price) : t('catalog.userDefinedPrice');

  return <article
    className={`${styles.productCard} ${isDragging ? styles.dragging : ''} ${available ? '' : styles.unavailable}`}
    ref={setNodeRef}
    style={{ transform: CSS.Transform.toString(transform), transition }}
  >
    <div className={styles.productBody}>
      <span className={styles.productImage}>
        {product?.imageUrl ? <ManagedImageFrame alt="" fallback={name.slice(0, 1)} frameClassName={styles.imageFrame} sizes="104px" src={product.imageUrl} /> : <span aria-hidden="true" className={styles.imageFallback}>{name.slice(0, 1)}</span>}
      </span>
      <div className={styles.productText}><strong title={name}>{name}</strong>{product ? <span>{price}</span> : null}{!available ? <small className={styles.unavailableBadge}>{t('kiosk.unavailableProduct')}</small> : null}</div>
    </div>
    <div className={styles.cardActions}>
      <IconButton className={styles.remove} label={t('kiosk.removeProduct', { name })} onClick={() => onRemove(id)} variant="surface"><X aria-hidden="true" size={17} /></IconButton>
      <IconButton {...attributes} {...listeners} className={styles.dragHandle} label={t('kiosk.composerDrag', { name })} variant="surface"><GripVertical aria-hidden="true" size={18} /></IconButton>
    </div>
  </article>;
}

/**
 * Edits the ordered product list as a two-column poster preview.
 *
 * Selected products remain visible even if archived or deleted so an administrator
 * can remove stale references before printing. Pointer, touch, and keyboard
 * drag all update the same ordered ID list.
 *
 * @param props - Catalog, ordered IDs, and controlled change callback.
 * @returns Visual poster product grid and searchable category picker.
 */
export function PosterProductComposer({ categories, productIds, onChange }: PosterProductComposerProps) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 7 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const orderedCategories = useMemo(() => [...categories].sort((a, b) => a.sortOrder - b.sortOrder), [categories]);
  const productIndex = useMemo(() => new Map(orderedCategories.flatMap((category) => category.products.map((product) => [product.id, { product, categoryActive: category.active }] as const))), [orderedCategories]);
  const selectedIds = useMemo(() => new Set(productIds), [productIds]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const pickerCategories = orderedCategories.filter((category) => category.active).map((category) => ({
    category,
    products: category.products.filter((product) => product.active && !selectedIds.has(product.id) && product.name.toLocaleLowerCase().includes(normalizedQuery)).sort((a, b) => a.sortOrder - b.sortOrder),
  })).filter(({ products }) => products.length > 0);

  useEffect(() => {
    if (pickerOpen) searchRef.current?.focus();
  }, [pickerOpen]);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = productIds.indexOf(String(active.id));
    const to = productIds.indexOf(String(over.id));
    if (from >= 0 && to >= 0) onChange(arrayMove(productIds, from, to));
  };
  const add = (id: string) => {
    if (productIds.length >= MAX_POSTER_PRODUCTS || selectedIds.has(id)) return;
    onChange([...productIds, id]);
    setPickerOpen(false);
    setQuery('');
  };

  return <section aria-label={t('kiosk.composerTitle')} className={styles.composer}>
    <div className={styles.composerHeading}><div><strong>{t('kiosk.composerTitle')}</strong><p>{t('kiosk.composerHint')}</p></div><span>{productIds.length}/{MAX_POSTER_PRODUCTS}</span></div>
    <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd} sensors={sensors}>
      <SortableContext items={productIds} strategy={rectSortingStrategy}>
        <div className={styles.productGrid}>
          {productIds.map((id) => {
            const entry = productIndex.get(id);
            return <PosterProductCard categoryActive={entry?.categoryActive ?? false} id={id} key={id} onRemove={(removedId) => onChange(productIds.filter((item) => item !== removedId))} product={entry?.product} />;
          })}
          {productIds.length < MAX_POSTER_PRODUCTS ? <button aria-expanded={pickerOpen} aria-label={t('kiosk.composerAdd')} className={styles.addCard} onClick={() => setPickerOpen((open) => !open)} type="button"><span><Plus aria-hidden="true" size={23} /></span><strong>{t('kiosk.composerAdd')}</strong></button> : null}
        </div>
      </SortableContext>
    </DndContext>
    {pickerOpen ? <div className={styles.picker} onKeyDown={(event) => { if (event.key === 'Escape') setPickerOpen(false); }}>
      <div className={styles.pickerHeading}><strong>{t('kiosk.composerPickerTitle')}</strong><button aria-label={t('common.close')} onClick={() => setPickerOpen(false)} type="button"><X aria-hidden="true" size={18} /></button></div>
      <label className={styles.search}><Search aria-hidden="true" size={18} /><input aria-label={t('kiosk.composerSearch')} onChange={(event) => setQuery(event.target.value)} placeholder={t('kiosk.composerSearch')} ref={searchRef} type="search" value={query} /></label>
      {pickerCategories.length > 0 ? <div className={styles.pickerGroups}>{pickerCategories.map(({ category, products }) => <section className={styles.pickerGroup} key={category.id}><h5>{category.name}</h5><div>{products.map((product) => <button key={product.id} onClick={() => add(product.id)} type="button"><span className={styles.pickerImage}>{product.imageUrl ? <ManagedImageFrame alt="" fallback={product.name.slice(0, 1)} frameClassName={styles.pickerImageFrame} sizes="48px" src={product.imageUrl} /> : product.name.slice(0, 1)}</span><span className={styles.pickerProduct}><strong>{product.name}</strong><small>{product.pricingMode === 'FIXED' && product.price ? formatMoney(product.price) : t('catalog.userDefinedPrice')}</small></span><Plus aria-hidden="true" size={17} /></button>)}</div></section>)}</div> : <p className={styles.noMatches}>{t('kiosk.composerNoMatches')}</p>}
    </div> : null}
  </section>;
}
