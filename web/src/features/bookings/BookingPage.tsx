import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import MousePointerClick from 'lucide-react/dist/esm/icons/mouse-pointer-click';
import WalletCards from 'lucide-react/dist/esm/icons/wallet-cards';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney, isCreditBalance } from '@/api/money';
import type { Product } from '@/api/types';
import { hasGroupCapability } from '@/app/groupCapabilities';
import { memberPaths } from '@/app/paths';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Modal } from '@/components/ui/Modal';
import { StatePanel } from '@/components/ui/StatePanel';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { BookingInspector } from './BookingInspector';
import { ProductPicker } from './ProductPicker';
import { getBookableCategories } from './bookable';
import styles from './BookingPage.module.css';

/**
 * Renders the dedicated, mobile-first product booking page.
 *
 * @returns Product choices and a responsive booking inspector.
 */
export function BookingPage() {
  const { t } = useTranslation();
  const { activeGroupId, activeGroup } = useActiveGroup();
  const categoriesQuery = useQuery({ queryKey: ['categories', activeGroupId], queryFn: () => api.getCategories(activeGroupId) });
  const bookingContextQuery = useQuery({ queryKey: ['booking-context', activeGroupId], queryFn: () => api.getBookingContext(activeGroupId, activeGroup.currency) });
  const compact = useMediaQuery('(max-width: 1023px)');
  const [categoryId, setCategoryId] = useState('');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const bookableCategories = useMemo(() => getBookableCategories(categoriesQuery.data ?? []), [categoriesQuery.data]);
  const selectedProduct = useMemo(() => {
    const products = bookableCategories.flatMap((category) => category.products);
    return products.find((product) => product.id === selectedProductId);
  }, [bookableCategories, selectedProductId]);
  const selectedCategory = bookableCategories.find((category) => category.id === selectedProduct?.categoryId);
  const hasBookableProducts = bookableCategories.some((category) => category.products.length > 0);
  const canManageCatalog = hasGroupCapability(activeGroup.membership?.effectiveGrants, 'catalog');

  const clearSelection = () => {
    setSelectedProductId('');
    setSheetOpen(false);
  };

  const chooseProduct = (product: Product) => {
    setSelectedProductId(product.id);
    setSheetOpen(true);
  };
  const changeCategory = (nextCategoryId: string) => {
    setCategoryId(nextCategoryId);
    clearSelection();
  };

  if (categoriesQuery.isLoading || bookingContextQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (categoriesQuery.isError || bookingContextQuery.isError || !categoriesQuery.data || !bookingContextQuery.data) {
    return <div className={styles.state}><StatePanel kind="error" message={t('booking.productsError')} /></div>;
  }
  if (bookingContextQuery.data.targets.length === 0 && !bookingContextQuery.data.canBookForGuests) {
    return <div className={styles.state}><StatePanel kind="empty" title={t('booking.noAccessTitle')} message={t('booking.noAccessMessage')} /></div>;
  }
  if (!hasBookableProducts) {
    return <div className={styles.state}><StatePanel kind="empty" title={t('booking.noProductsTitle')} message={t('booking.noProductsMessage')}>{canManageCatalog ? <Link className={styles.catalogLink} to={memberPaths.catalog}>{t('booking.catalogLink')}</Link> : null}</StatePanel></div>;
  }

  const hasCreditBalance = isCreditBalance(bookingContextQuery.data.ownBalance);

  const inspector = selectedProduct && selectedCategory ? (
    <BookingInspector
      compact
      canBookForGuests={bookingContextQuery.data.canBookForGuests}
      currentMembershipId={bookingContextQuery.data.currentMembership.id}
      groupId={activeGroupId}
      key={selectedProduct.id}
      onBooked={clearSelection}
      onCancel={clearSelection}
      period={bookingContextQuery.data.openPeriod}
      product={selectedProduct}
      targets={bookingContextQuery.data.targets}
    />
  ) : null;

  return (
    <div className={styles.layout}>
      <section className={styles.content}>
        <h1>{t('booking.quickTitle')}</h1>
        <div className={styles.balance}>
          <div><span>{t('booking.openBalance')}</span><strong className={hasCreditBalance ? styles.creditBalance : undefined} data-financial-state={hasCreditBalance ? 'credit' : 'due'}>{formatMoney(bookingContextQuery.data.ownBalance)}</strong></div>
          <WalletCards aria-hidden="true" size={40} strokeWidth={1.8} />
        </div>
        <ProductPicker
          categories={bookableCategories}
          layout="rows"
          onCategoryChange={changeCategory}
          onProductSelect={chooseProduct}
          selectedCategoryId={categoryId || bookableCategories[0]?.id || ''}
          selectedProductId={selectedProduct?.id}
        />
      </section>
      {!compact ? (
        <aside
          aria-label={selectedProduct ? t('booking.productTitle', { name: selectedProduct.name }) : t('booking.selectProductTitle')}
          className={styles.inspector}
        >
          {inspector ?? (
            <div className={styles.inspectorEmpty}>
              <MousePointerClick aria-hidden="true" size={42} strokeWidth={1.6} />
              <strong>{t('booking.selectProductTitle')}</strong>
              <p>{t('booking.selectProductMessage')}</p>
            </div>
          )}
        </aside>
      ) : null}
      {compact && selectedProduct && inspector ? (
        <Modal onClose={clearSelection} open={sheetOpen} title={t('booking.productTitle', { name: selectedProduct.name })} variant="sheet">
          {inspector}
        </Modal>
      ) : null}
    </div>
  );
}
