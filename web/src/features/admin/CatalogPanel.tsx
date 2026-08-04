import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Archive from 'lucide-react/dist/esm/icons/archive';
import Gavel from 'lucide-react/dist/esm/icons/gavel';
import GlassWater from 'lucide-react/dist/esm/icons/glass-water';
import ImagePlus from 'lucide-react/dist/esm/icons/image-plus';
import Plus from 'lucide-react/dist/esm/icons/plus';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney, majorUnitsInputPattern, majorUnitsPlaceholder, parseMajorUnits } from '@/api/money';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput, TextInput } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { StatePanel } from '@/components/ui/StatePanel';
import styles from './CatalogPanel.module.css';

type CatalogDialog = 'category' | 'product' | null;

/**
 * Renders the category and product catalogue editor.
 *
 * Product creation and image upload are separate operations so a failed image
 * upload can be retried without creating another product.
 *
 * @returns A localized catalogue workspace with resilient creation dialogs.
 */
export function CatalogPanel() {
  const { t } = useTranslation();
  const { activeGroupId, activeGroup } = useActiveGroup();
  const queryClient = useQueryClient();
  const categoriesQuery = useQuery({ queryKey: ['categories', activeGroupId], queryFn: () => api.getCategories(activeGroupId) });
  const [dialog, setDialog] = useState<CatalogDialog>(null);
  const [categoryName, setCategoryName] = useState('');
  const [productCategoryId, setProductCategoryId] = useState('');
  const [productName, setProductName] = useState('');
  const [productPrice, setProductPrice] = useState('');
  const [productImage, setProductImage] = useState<File | undefined>();
  const [createdProduct, setCreatedProduct] = useState<Awaited<ReturnType<typeof api.createProduct>> | null>(null);

  const clearProductDialog = () => {
    setDialog(null);
    setProductName('');
    setProductPrice('');
    setProductImage(undefined);
    setCreatedProduct(null);
  };

  const categoryMutation = useMutation({
    mutationFn: () => api.createCategory(activeGroupId, { name: categoryName.trim() }),
    onSuccess: async () => { setDialog(null); setCategoryName(''); await queryClient.invalidateQueries({ queryKey: ['categories', activeGroupId] }); },
  });
  const imageMutation = useMutation({
    mutationFn: ({ productId, image }: { productId: string; image: File }) => api.uploadProductImage(activeGroupId, productId, image),
    onSuccess: async () => {
      clearProductDialog();
      await queryClient.invalidateQueries({ queryKey: ['categories', activeGroupId] });
    },
  });
  const productMutation = useMutation({
    mutationFn: () => api.createProduct(activeGroupId, {
      categoryId: productCategoryId || categoriesQuery.data?.[0]?.id || '',
      name: productName.trim(),
      price: { minorUnits: parseMajorUnits(productPrice, activeGroup.currency), currency: activeGroup.currency },
    }),
    onSuccess: async (product) => {
      await queryClient.invalidateQueries({ queryKey: ['categories', activeGroupId] });
      if (!productImage) {
        clearProductDialog();
        return;
      }
      setCreatedProduct(product);
      imageMutation.mutate({ productId: product.id, image: productImage });
    },
  });

  if (categoriesQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (!categoriesQuery.data) return <div className={styles.state}><StatePanel kind="error" message={t('catalog.error')} /></div>;

  return (
    <div className={styles.content}>
      <header className={styles.header}><div><h2>{t('catalog.title')}</h2><p>{t('catalog.intro')}</p></div><div><Button leadingIcon={<Plus size={18} />} onClick={() => setDialog('category')} variant="secondary">{t('catalog.categoryAction')}</Button><Button leadingIcon={<Plus size={18} />} onClick={() => setDialog('product')}>{t('catalog.productAction')}</Button></div></header>
      {categoriesQuery.data.length === 0 ? <StatePanel actionLabel={t('catalog.createCategoryAction')} kind="empty" message={t('catalog.empty')} onAction={() => setDialog('category')} /> : (
        <div className={styles.categories}>
          {categoriesQuery.data.map((category) => {
            const Icon = category.icon === 'drink' ? GlassWater : category.icon === 'penalty' ? Gavel : Archive;
            return (
              <section className={styles.category} key={category.id}>
                <header><span><Icon size={22} /></span><div><h3>{category.name}</h3><p>{t('catalog.productCount', { count: category.products.length })}</p></div></header>
                {category.products.length === 0 ? <p className={styles.emptyProducts}>{t('catalog.emptyProducts')}</p> : (
                  <div className={styles.products}>{category.products.map((product) => <article className={!product.active ? styles.archived : ''} key={product.id}>{product.imageUrl ? <img alt="" src={product.imageUrl} /> : <span className={styles.imageFallback}><ImagePlus size={26} /></span>}<div><strong>{product.name}</strong><span>{formatMoney(product.price)}</span></div><small>{product.active ? t('common.active') : t('common.archived')}</small></article>)}</div>
                )}
              </section>
            );
          })}
        </div>
      )}
      <Modal onClose={() => setDialog(null)} open={dialog === 'category'} title={t('catalog.categoryDialog')}>
        <form className={styles.form} onSubmit={(event) => { event.preventDefault(); categoryMutation.mutate(); }}>
          <Field htmlFor="category-name" label={t('common.name')}><TextInput id="category-name" onChange={(event) => setCategoryName(event.target.value)} required value={categoryName} /></Field>
          {categoryMutation.isError ? <p className={styles.error}>{categoryMutation.error.message}</p> : null}
          <div className={styles.actions}><Button onClick={() => setDialog(null)} variant="secondary">{t('common.cancel')}</Button><Button disabled={!categoryName.trim() || categoryMutation.isPending} type="submit">{t('catalog.createCategoryAction')}</Button></div>
        </form>
      </Modal>
      <Modal onClose={clearProductDialog} open={dialog === 'product'} title={t('catalog.productDialog')}>
        <form className={styles.form} onSubmit={(event) => {
          event.preventDefault();
          if (createdProduct && productImage) imageMutation.mutate({ productId: createdProduct.id, image: productImage });
          else if (!createdProduct) productMutation.mutate();
        }}>
          {createdProduct ? <div className={styles.hint} role="status"><strong>{t('catalog.partialSuccessTitle')}</strong><p>{t('catalog.partialSuccessMessage', { name: createdProduct.name })}</p></div> : null}
          <Field htmlFor="product-category" label={t('common.category')}><SelectInput disabled={Boolean(createdProduct)} id="product-category" onChange={(event) => setProductCategoryId(event.target.value)} value={productCategoryId || categoriesQuery.data[0]?.id}>{categoriesQuery.data.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</SelectInput></Field>
          <Field htmlFor="product-name" label={t('catalog.productName')}><TextInput disabled={Boolean(createdProduct)} id="product-name" onChange={(event) => setProductName(event.target.value)} required value={productName} /></Field>
          <Field htmlFor="product-price" label={t('catalog.price', { currency: activeGroup.currency })}><TextInput disabled={Boolean(createdProduct)} id="product-price" inputMode="decimal" onChange={(event) => setProductPrice(event.target.value)} pattern={majorUnitsInputPattern(activeGroup.currency)} placeholder={majorUnitsPlaceholder(activeGroup.currency)} required type="text" value={productPrice} /></Field>
          <Field hint={createdProduct ? t('catalog.replaceImage') : t('catalog.imageHint')} htmlFor="product-image" label={t('catalog.image')}><TextInput accept="image/jpeg,image/png,image/webp" id="product-image" onChange={(event) => { setProductImage(event.target.files?.[0]); imageMutation.reset(); }} type="file" /></Field>
          {productMutation.isError ? <p className={styles.error} role="alert">{productMutation.error.message}</p> : null}
          {createdProduct && imageMutation.isError ? <p className={styles.error} role="alert">{t('catalog.imageUploadError')} {imageMutation.error.message}</p> : null}
          <div className={styles.actions}>
            <Button onClick={clearProductDialog} variant="secondary">{createdProduct ? t('catalog.finishWithoutImage') : t('common.cancel')}</Button>
            <Button disabled={!productName.trim() || !productPrice || productMutation.isPending || imageMutation.isPending || Boolean(createdProduct && !productImage)} type="submit">
              {createdProduct ? imageMutation.isPending ? t('catalog.imageUploadPending') : t('catalog.retryImage') : t('catalog.createProductAction')}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
