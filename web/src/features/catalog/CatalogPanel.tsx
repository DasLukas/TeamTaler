import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Plus from 'lucide-react/dist/esm/icons/plus';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { majorUnitsInputPattern, majorUnitsInputValue, majorUnitsPlaceholder, validatePositiveMajorUnits } from '@/api/money';
import type { Category, CategoryIcon as CategoryIconName, Product, ProductPricingMode } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput, TextInput } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { StatePanel } from '@/components/ui/StatePanel';
import { catalogOrderCommand } from './catalogOrder';
import { CategoryIconPicker } from './CategoryIconPicker';
import { CatalogSorter } from './CatalogSorter';
import styles from './CatalogPanel.module.css';

type CatalogDialog = 'category' | 'product' | 'delete' | null;
type DeleteTarget = { kind: 'category'; item: Category } | { kind: 'product'; item: Product };

/**
 * Renders the version-aware category and product catalog editor.
 *
 * Creation, metadata updates, ordering, and image upload remain separate
 * operations so a failed image upload can be retried without duplicating or
 * reverting a product and failed ordering can restore the cached snapshot.
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
  const [categoryIcon, setCategoryIcon] = useState<CategoryIconName>('other');
  const [categoryActive, setCategoryActive] = useState(true);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [productCategoryId, setProductCategoryId] = useState('');
  const [productName, setProductName] = useState('');
  const [productPricingMode, setProductPricingMode] = useState<ProductPricingMode>('FIXED');
  const [productPrice, setProductPrice] = useState('');
  const [productPriceTouched, setProductPriceTouched] = useState(false);
  const [productActive, setProductActive] = useState(true);
  const [productImage, setProductImage] = useState<File | undefined>();
  const [productImageInputKey, setProductImageInputKey] = useState(0);
  const [persistedProduct, setPersistedProduct] = useState<Product | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const invalidateCatalog = () => queryClient.invalidateQueries({ queryKey: ['categories', activeGroupId] });

  const resetProductImageInput = () => {
    setProductImage(undefined);
    setProductImageInputKey((current) => current + 1);
  };

  const clearCategoryDialog = () => {
    setDialog(null);
    setEditingCategory(null);
    setCategoryName('');
    setCategoryIcon('other');
    setCategoryActive(true);
  };

  const openNewCategory = () => {
    categoryMutation.reset();
    setEditingCategory(null);
    setCategoryName('');
    setCategoryIcon('other');
    setCategoryActive(true);
    setDialog('category');
  };

  const openCategoryEditor = (category: Category) => {
    categoryMutation.reset();
    setEditingCategory(category);
    setCategoryName(category.name);
    setCategoryIcon(category.icon);
    setCategoryActive(category.active);
    setDialog('category');
  };

  const openCategoryDeletion = (category: Category) => {
    deleteMutation.reset();
    setDeleteTarget({ kind: 'category', item: category });
    setDialog('delete');
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
    resetProductImageInput();
    setPersistedProduct(null);
  };

  const resetProductMutations = () => {
    productMutation.reset();
    imageMutation.reset();
  };

  const openNewProduct = (categoryId?: string) => {
    resetProductMutations();
    setEditingProduct(null);
    setProductCategoryId(categoryId ?? categoriesQuery.data?.[0]?.id ?? '');
    setProductName('');
    setProductPricingMode('FIXED');
    setProductPrice('');
    setProductPriceTouched(false);
    setProductActive(true);
    resetProductImageInput();
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
    resetProductImageInput();
    setPersistedProduct(null);
    setDialog('product');
  };

  const openProductDeletion = (product: Product) => {
    deleteMutation.reset();
    setDeleteTarget({ kind: 'product', item: product });
    setDialog('delete');
  };

  const closeDeleteDialog = () => {
    deleteMutation.reset();
    setDialog(deleteTarget?.kind === 'category' ? 'category' : 'product');
    setDeleteTarget(null);
  };

  const categoryMutation = useMutation({
    mutationFn: () => editingCategory
      ? api.updateCategory(activeGroupId, editingCategory.id, {
          name: categoryName.trim(),
          icon: categoryIcon,
          active: categoryActive,
          sortOrder: editingCategory.sortOrder,
          version: editingCategory.version,
        })
      : api.createCategory(activeGroupId, { name: categoryName.trim(), icon: categoryIcon }),
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

  const deleteMutation = useMutation({
    mutationFn: (target: DeleteTarget) => target.kind === 'category'
      ? api.deleteCategory(activeGroupId, target.item.id, target.item.version)
      : api.deleteProduct(activeGroupId, target.item.id, target.item.version),
    onSuccess: async (_result, target) => {
      if (target.kind === 'category') clearCategoryDialog();
      else clearProductDialog();
      setDeleteTarget(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['categories', activeGroupId] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard', activeGroupId] }),
      ]);
    },
    onError: async () => { await invalidateCatalog(); },
  });

  const reorderMutation = useMutation({
    mutationFn: (categories: Category[]) => api.reorderCatalog(activeGroupId, catalogOrderCommand(categories)),
    onMutate: async (categories) => {
      await queryClient.cancelQueries({ queryKey: ['categories', activeGroupId] });
      const previous = queryClient.getQueryData<Category[]>(['categories', activeGroupId]);
      queryClient.setQueryData(['categories', activeGroupId], categories);
      return { previous };
    },
    onError: (_error, _categories, context) => {
      if (context?.previous) queryClient.setQueryData(['categories', activeGroupId], context.previous);
    },
    onSuccess: (categories) => queryClient.setQueryData(['categories', activeGroupId], categories),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['categories', activeGroupId] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard', activeGroupId] }),
      ]);
    },
  });

  if (categoriesQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (!categoriesQuery.data) return <div className={styles.state}><StatePanel kind="error" message={t('catalog.error')} /></div>;

  const productPriceValidation = productPricingMode === 'FIXED' ? validatePositiveMajorUnits(productPrice, activeGroup.currency) : {};
  const productPriceValid = productPricingMode === 'USER_DEFINED' || Boolean(productPriceValidation.minorUnits);
  const metadataLocked = Boolean(persistedProduct);
  const deleteProblemStatus = deleteMutation.error && 'problem' in deleteMutation.error
    ? (deleteMutation.error as { problem?: { status?: number } }).problem?.status
    : undefined;
  const deleteError = deleteProblemStatus === 412
    ? t('catalog.deleteStaleError')
    : deleteTarget?.kind === 'category'
      ? deleteTarget.item.products.length > 0 ? t('catalog.deleteCategoryProductsError') : t('catalog.deleteCategoryHistoryError')
      : t('catalog.deleteProductHistoryError');

  return (
    <div className={styles.content}>
      <header className={styles.header}>
        <div><p>{t('catalog.intro')}</p><p className={styles.reorderHint}>{t('catalog.reorderHint')}</p></div>
        <div>
          <Button leadingIcon={<Plus size={18} />} onClick={openNewCategory} variant="secondary">{t('catalog.categoryAction')}</Button>
          <Button disabled={categoriesQuery.data.length === 0} leadingIcon={<Plus size={18} />} onClick={() => openNewProduct()}>{t('catalog.productAction')}</Button>
        </div>
      </header>
      {reorderMutation.isPending ? <p className={styles.reorderStatus} role="status">{t('catalog.reorderSaving')}</p> : null}
      {reorderMutation.isError ? <p className={`${styles.reorderStatus} ${styles.error}`} role="alert">{t('catalog.reorderError')}</p> : null}
      {categoriesQuery.data.length === 0 ? <StatePanel actionLabel={t('catalog.createCategoryAction')} kind="empty" message={t('catalog.empty')} onAction={openNewCategory} /> : (
        <CatalogSorter
          categories={categoriesQuery.data}
          disabled={reorderMutation.isPending}
          onAddCategory={openNewCategory}
          onAddProduct={openNewProduct}
          onEditCategory={openCategoryEditor}
          onEditProduct={openProductEditor}
          onReorder={(categories) => reorderMutation.mutate(categories)}
        />
      )}
      <Modal onClose={clearCategoryDialog} open={dialog === 'category'} title={editingCategory ? t('catalog.editCategoryDialog') : t('catalog.categoryDialog')}>
        <form className={styles.form} onSubmit={(event) => { event.preventDefault(); categoryMutation.mutate(); }}>
          <Field htmlFor="category-name" label={t('common.name')}><TextInput id="category-name" onChange={(event) => setCategoryName(event.target.value)} required value={categoryName} /></Field>
          <CategoryIconPicker onChange={setCategoryIcon} value={categoryIcon} />
          {editingCategory ? <Field htmlFor="category-status" label={t('common.status')}><SelectInput id="category-status" onChange={(event) => setCategoryActive(event.target.value === 'active')} value={categoryActive ? 'active' : 'archived'}><option value="active">{t('common.active')}</option><option value="archived">{t('common.archived')}</option></SelectInput></Field> : null}
          {categoryMutation.isError ? <p className={styles.error} role="alert">{categoryMutation.error.message}</p> : null}
          <div className={styles.actions}>
            {editingCategory && !editingCategory.active ? <Button className={styles.deleteAction} disabled={categoryMutation.isPending} leadingIcon={<Trash2 size={16} />} onClick={() => openCategoryDeletion(editingCategory)} variant="danger">{t('catalog.deletePermanently')}</Button> : null}
            <Button onClick={clearCategoryDialog} variant="secondary">{t('common.cancel')}</Button><Button disabled={!categoryName.trim() || categoryMutation.isPending} type="submit">{editingCategory ? t('common.save') : t('catalog.createCategoryAction')}</Button>
          </div>
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
          <Field hint={editingProduct || persistedProduct ? t('catalog.replaceImage') : t('catalog.imageHint')} htmlFor="product-image" label={t('catalog.image')}>
            <div className={styles.imageSelection}>
              <TextInput accept="image/jpeg,image/png,image/webp" id="product-image" key={productImageInputKey} onChange={(event) => { setProductImage(event.target.files?.[0]); imageMutation.reset(); }} type="file" />
              {productImage ? <Button leadingIcon={<Trash2 size={16} />} onClick={() => { resetProductImageInput(); imageMutation.reset(); }} size="small" variant="ghost">{t('catalog.removeSelectedImage')}</Button> : null}
            </div>
          </Field>
          {productMutation.isError ? <p className={styles.error} role="alert">{productMutation.error.message}</p> : null}
          {persistedProduct && imageMutation.isError ? <p className={styles.error} role="alert">{editingProduct ? t('catalog.imageUpdateError') : t('catalog.imageUploadError')} {imageMutation.error.message}</p> : null}
          <div className={styles.actions}>
            {editingProduct && !editingProduct.active && !persistedProduct ? <Button className={styles.deleteAction} disabled={productMutation.isPending} leadingIcon={<Trash2 size={16} />} onClick={() => openProductDeletion(editingProduct)} variant="danger">{t('catalog.deletePermanently')}</Button> : null}
            <Button onClick={clearProductDialog} variant="secondary">{persistedProduct ? t('catalog.finishWithoutImage') : t('common.cancel')}</Button>
            <Button disabled={!productName.trim() || !productPriceValid || productMutation.isPending || imageMutation.isPending || Boolean(persistedProduct && !productImage)} type="submit">
              {persistedProduct ? imageMutation.isPending ? t('catalog.imageUploadPending') : t('catalog.retryImage') : editingProduct ? t('common.save') : t('catalog.createProductAction')}
            </Button>
          </div>
        </form>
      </Modal>
      <Modal onClose={() => { if (!deleteMutation.isPending) closeDeleteDialog(); }} open={dialog === 'delete'} title={deleteTarget?.kind === 'category' ? t('catalog.deleteCategoryTitle') : t('catalog.deleteProductTitle')}>
        <div className={styles.deleteConfirmation}>
          <p>{deleteTarget ? t(deleteTarget.kind === 'category' ? 'catalog.deleteCategoryExplanation' : 'catalog.deleteProductExplanation', { name: deleteTarget.item.name }) : null}</p>
          {deleteTarget?.kind === 'category' && deleteTarget.item.products.length > 0 ? <p className={styles.hint}>{t('catalog.deleteCategoryProductsHint')}</p> : null}
          {deleteMutation.isError ? <p className={styles.error} role="alert">{deleteError}</p> : null}
          <div className={styles.actions}>
            <Button disabled={deleteMutation.isPending} onClick={closeDeleteDialog} variant="secondary">{t('common.cancel')}</Button>
            <Button disabled={!deleteTarget || deleteMutation.isPending} leadingIcon={<Trash2 size={16} />} onClick={() => { if (deleteTarget) deleteMutation.mutate(deleteTarget); }} variant="danger">{deleteMutation.isPending ? t('catalog.deleting') : t('catalog.confirmDelete')}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
