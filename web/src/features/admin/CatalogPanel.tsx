import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Archive from 'lucide-react/dist/esm/icons/archive';
import Gavel from 'lucide-react/dist/esm/icons/gavel';
import GlassWater from 'lucide-react/dist/esm/icons/glass-water';
import ImagePlus from 'lucide-react/dist/esm/icons/image-plus';
import Pencil from 'lucide-react/dist/esm/icons/pencil';
import Plus from 'lucide-react/dist/esm/icons/plus';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney, majorUnitsInputPattern, majorUnitsInputValue, majorUnitsPlaceholder, validatePositiveMajorUnits } from '@/api/money';
import type { Category, Product, ProductPricingMode } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput, TextInput } from '@/components/ui/FormField';
import { IconButton } from '@/components/ui/IconButton';
import { Modal } from '@/components/ui/Modal';
import { StatePanel } from '@/components/ui/StatePanel';
import styles from './CatalogPanel.module.css';

type CatalogDialog = 'category' | 'product' | null;

/**
 * Renders the version-aware category and product catalogue editor.
 *
 * Creation, metadata updates, and image upload remain separate operations so a
 * failed image upload can be retried without duplicating or reverting a product.
 *
 * @returns A localized catalogue workspace with create and edit dialogs.
 */
export function CatalogPanel() {
  const { t } = useTranslation();
  const { activeGroupId, activeGroup } = useActiveGroup();
  const queryClient = useQueryClient();
  const categoriesQuery = useQuery({ queryKey: ['categories', activeGroupId], queryFn: () => api.getCategories(activeGroupId) });
  const [dialog, setDialog] = useState<CatalogDialog>(null);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [categoryName, setCategoryName] = useState('');
  const [categoryActive, setCategoryActive] = useState(true);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [productCategoryId, setProductCategoryId] = useState('');
  const [productName, setProductName] = useState('');
  const [productPricingMode, setProductPricingMode] = useState<ProductPricingMode>('FIXED');
  const [productPrice, setProductPrice] = useState('');
  const [productPriceTouched, setProductPriceTouched] = useState(false);
  const [productActive, setProductActive] = useState(true);
  const [productImage, setProductImage] = useState<File | undefined>();
  const [persistedProduct, setPersistedProduct] = useState<Product | null>(null);

  const invalidateCatalog = () => queryClient.invalidateQueries({ queryKey: ['categories', activeGroupId] });

  const clearCategoryDialog = () => {
    setDialog(null);
    setEditingCategory(null);
    setCategoryName('');
    setCategoryActive(true);
  };

  const openNewCategory = () => {
    categoryMutation.reset();
    setEditingCategory(null);
    setCategoryName('');
    setCategoryActive(true);
    setDialog('category');
  };

  const openCategoryEditor = (category: Category) => {
    categoryMutation.reset();
    setEditingCategory(category);
    setCategoryName(category.name);
    setCategoryActive(category.active);
    setDialog('category');
  };

  const clearProductDialog = () => {
    setDialog(null);
    setEditingProduct(null);
    setProductCategoryId('');
    setProductName('');
    setProductPricingMode('FIXED');
    setProductPrice('');
    setProductPriceTouched(false);
    setProductActive(true);
    setProductImage(undefined);
    setPersistedProduct(null);
  };

  const resetProductMutations = () => {
    productMutation.reset();
    imageMutation.reset();
  };

  const openNewProduct = () => {
    resetProductMutations();
    setEditingProduct(null);
    setProductCategoryId(categoriesQuery.data?.[0]?.id ?? '');
    setProductName('');
    setProductPricingMode('FIXED');
    setProductPrice('');
    setProductPriceTouched(false);
    setProductActive(true);
    setProductImage(undefined);
    setPersistedProduct(null);
    setDialog('product');
  };

  const openProductEditor = (product: Product) => {
    resetProductMutations();
    setEditingProduct(product);
    setProductCategoryId(product.categoryId);
    setProductName(product.name);
    setProductPricingMode(product.pricingMode);
    setProductPrice(product.price ? majorUnitsInputValue(product.price) : '');
    setProductPriceTouched(false);
    setProductActive(product.active);
    setProductImage(undefined);
    setPersistedProduct(null);
    setDialog('product');
  };

  const categoryMutation = useMutation({
    mutationFn: () => editingCategory
      ? api.updateCategory(activeGroupId, editingCategory.id, {
          name: categoryName.trim(),
          active: categoryActive,
          sortOrder: editingCategory.sortOrder,
          version: editingCategory.version,
        })
      : api.createCategory(activeGroupId, { name: categoryName.trim() }),
    onSuccess: async () => {
      clearCategoryDialog();
      await invalidateCatalog();
    },
    onError: async () => { await invalidateCatalog(); },
  });

  const imageMutation = useMutation({
    mutationFn: ({ productId, image }: { productId: string; image: File }) => api.uploadProductImage(activeGroupId, productId, image),
    onSuccess: async () => {
      clearProductDialog();
      await invalidateCatalog();
    },
  });

  const productMutation = useMutation({
    mutationFn: () => {
      const validation = validatePositiveMajorUnits(productPrice, activeGroup.currency);
      if (productPricingMode === 'FIXED' && !validation.minorUnits) {
        throw new Error(validation.error ?? t('errors.amountFormat'));
      }
      const price = productPricingMode === 'FIXED' && validation.minorUnits
        ? { minorUnits: validation.minorUnits, currency: activeGroup.currency }
        : undefined;
      if (editingProduct) {
        return api.updateProduct(activeGroupId, editingProduct.id, {
          name: productName.trim(),
          pricingMode: productPricingMode,
          price,
          active: productActive,
          sortOrder: editingProduct.sortOrder,
          version: editingProduct.version,
        });
      }
      return api.createProduct(activeGroupId, {
        categoryId: productCategoryId || categoriesQuery.data?.[0]?.id || '',
        name: productName.trim(),
        pricingMode: productPricingMode,
        price,
      });
    },
    onSuccess: async (product) => {
      await invalidateCatalog();
      if (!productImage) {
        clearProductDialog();
        return;
      }
      setPersistedProduct(product);
      imageMutation.mutate({ productId: product.id, image: productImage });
    },
    onError: async () => { await invalidateCatalog(); },
  });

  if (categoriesQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (!categoriesQuery.data) return <div className={styles.state}><StatePanel kind="error" message={t('catalog.error')} /></div>;

  const productPriceValidation = productPricingMode === 'FIXED' ? validatePositiveMajorUnits(productPrice, activeGroup.currency) : {};
  const productPriceValid = productPricingMode === 'USER_DEFINED' || Boolean(productPriceValidation.minorUnits);
  const metadataLocked = Boolean(persistedProduct);

  return (
    <div className={styles.content}>
      <header className={styles.header}>
        <div><h2>{t('catalog.title')}</h2><p>{t('catalog.intro')}</p></div>
        <div>
          <Button leadingIcon={<Plus size={18} />} onClick={openNewCategory} variant="secondary">{t('catalog.categoryAction')}</Button>
          <Button disabled={categoriesQuery.data.length === 0} leadingIcon={<Plus size={18} />} onClick={openNewProduct}>{t('catalog.productAction')}</Button>
        </div>
      </header>
      {categoriesQuery.data.length === 0 ? <StatePanel actionLabel={t('catalog.createCategoryAction')} kind="empty" message={t('catalog.empty')} onAction={openNewCategory} /> : (
        <div className={styles.categories}>
          {categoriesQuery.data.map((category) => {
            const Icon = category.icon === 'drink' ? GlassWater : category.icon === 'penalty' ? Gavel : Archive;
            return (
              <section className={`${styles.category} ${!category.active ? styles.archived : ''}`} key={category.id}>
                <header>
                  <span><Icon size={22} /></span>
                  <div><h3>{category.name}</h3><p>{t('catalog.productCount', { count: category.products.length })} · {category.active ? t('common.active') : t('common.archived')}</p></div>
                  <IconButton className={styles.categoryEdit} label={t('catalog.editCategory', { name: category.name })} onClick={() => openCategoryEditor(category)} variant="surface"><Pencil size={17} /></IconButton>
                </header>
                {category.products.length === 0 ? <p className={styles.emptyProducts}>{t('catalog.emptyProducts')}</p> : (
                  <div className={styles.products}>{category.products.map((product) => (
                    <article className={!product.active ? styles.archived : ''} key={product.id}>
                      {product.imageUrl ? <img alt="" src={product.imageUrl} /> : <span className={styles.imageFallback}><ImagePlus size={26} /></span>}
                      <div><strong>{product.name}</strong><span>{product.pricingMode === 'FIXED' && product.price ? formatMoney(product.price) : t('catalog.userDefinedPrice')}</span></div>
                      <small>{product.active ? t('common.active') : t('common.archived')}</small>
                      <IconButton className={styles.productEdit} label={t('catalog.editProduct', { name: product.name })} onClick={() => openProductEditor(product)} variant="surface"><Pencil size={16} /></IconButton>
                    </article>
                  ))}</div>
                )}
              </section>
            );
          })}
        </div>
      )}
      <Modal onClose={clearCategoryDialog} open={dialog === 'category'} title={editingCategory ? t('catalog.editCategoryDialog') : t('catalog.categoryDialog')}>
        <form className={styles.form} onSubmit={(event) => { event.preventDefault(); categoryMutation.mutate(); }}>
          <Field htmlFor="category-name" label={t('common.name')}><TextInput id="category-name" onChange={(event) => setCategoryName(event.target.value)} required value={categoryName} /></Field>
          {editingCategory ? <Field htmlFor="category-status" label={t('common.status')}><SelectInput id="category-status" onChange={(event) => setCategoryActive(event.target.value === 'active')} value={categoryActive ? 'active' : 'archived'}><option value="active">{t('common.active')}</option><option value="archived">{t('common.archived')}</option></SelectInput></Field> : null}
          {categoryMutation.isError ? <p className={styles.error} role="alert">{categoryMutation.error.message}</p> : null}
          <div className={styles.actions}><Button onClick={clearCategoryDialog} variant="secondary">{t('common.cancel')}</Button><Button disabled={!categoryName.trim() || categoryMutation.isPending} type="submit">{editingCategory ? t('common.save') : t('catalog.createCategoryAction')}</Button></div>
        </form>
      </Modal>
      <Modal onClose={clearProductDialog} open={dialog === 'product'} title={editingProduct ? t('catalog.editProductDialog') : t('catalog.productDialog')}>
        <form className={styles.form} onSubmit={(event) => {
          event.preventDefault();
          if (persistedProduct && productImage) imageMutation.mutate({ productId: persistedProduct.id, image: productImage });
          else if (!persistedProduct) productMutation.mutate();
        }}>
          {persistedProduct ? <div className={styles.hint} role="status"><strong>{editingProduct ? t('catalog.updatePartialSuccessTitle') : t('catalog.partialSuccessTitle')}</strong><p>{editingProduct ? t('catalog.updatePartialSuccessMessage', { name: persistedProduct.name }) : t('catalog.partialSuccessMessage', { name: persistedProduct.name })}</p></div> : null}
          <Field htmlFor="product-category" label={t('common.category')}><SelectInput disabled={metadataLocked || Boolean(editingProduct)} id="product-category" onChange={(event) => setProductCategoryId(event.target.value)} value={productCategoryId || categoriesQuery.data[0]?.id}>{categoriesQuery.data.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</SelectInput></Field>
          <Field htmlFor="product-name" label={t('catalog.productName')}><TextInput disabled={metadataLocked} id="product-name" onChange={(event) => setProductName(event.target.value)} required value={productName} /></Field>
          <Field htmlFor="product-pricing-mode" label={t('catalog.pricingMode')}><SelectInput disabled={metadataLocked} id="product-pricing-mode" onChange={(event) => { setProductPricingMode(event.target.value as ProductPricingMode); setProductPrice(''); setProductPriceTouched(false); }} value={productPricingMode}><option value="FIXED">{t('catalog.fixedPrice')}</option><option value="USER_DEFINED">{t('catalog.userDefinedPrice')}</option></SelectInput></Field>
          {productPricingMode === 'FIXED' ? <Field error={productPriceTouched ? productPriceValidation.error : undefined} htmlFor="product-price" label={t('catalog.price', { currency: activeGroup.currency })}><TextInput disabled={metadataLocked} id="product-price" inputMode="decimal" onBlur={() => setProductPriceTouched(true)} onChange={(event) => setProductPrice(event.target.value)} pattern={majorUnitsInputPattern(activeGroup.currency)} placeholder={majorUnitsPlaceholder(activeGroup.currency)} required type="text" value={productPrice} /></Field> : null}
          {editingProduct ? <Field htmlFor="product-status" label={t('common.status')}><SelectInput disabled={metadataLocked} id="product-status" onChange={(event) => setProductActive(event.target.value === 'active')} value={productActive ? 'active' : 'archived'}><option value="active">{t('common.active')}</option><option value="archived">{t('common.archived')}</option></SelectInput></Field> : null}
          <Field hint={editingProduct || persistedProduct ? t('catalog.replaceImage') : t('catalog.imageHint')} htmlFor="product-image" label={t('catalog.image')}><TextInput accept="image/jpeg,image/png,image/webp" id="product-image" onChange={(event) => { setProductImage(event.target.files?.[0]); imageMutation.reset(); }} type="file" /></Field>
          {productMutation.isError ? <p className={styles.error} role="alert">{productMutation.error.message}</p> : null}
          {persistedProduct && imageMutation.isError ? <p className={styles.error} role="alert">{editingProduct ? t('catalog.imageUpdateError') : t('catalog.imageUploadError')} {imageMutation.error.message}</p> : null}
          <div className={styles.actions}>
            <Button onClick={clearProductDialog} variant="secondary">{persistedProduct ? t('catalog.finishWithoutImage') : t('common.cancel')}</Button>
            <Button disabled={!productName.trim() || !productPriceValid || productMutation.isPending || imageMutation.isPending || Boolean(persistedProduct && !productImage)} type="submit">
              {persistedProduct ? imageMutation.isPending ? t('catalog.imageUploadPending') : t('catalog.retryImage') : editingProduct ? t('common.save') : t('catalog.createProductAction')}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
