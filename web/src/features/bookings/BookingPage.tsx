import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import WalletCards from 'lucide-react/dist/esm/icons/wallet-cards';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney } from '@/api/money';
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
  const { activeGroupId, session } = useActiveGroup();
  const dashboardQuery = useQuery({ queryKey: ['dashboard', activeGroupId], queryFn: () => api.getDashboard(activeGroupId) });
  const categoriesQuery = useQuery({ queryKey: ['categories', activeGroupId], queryFn: () => api.getCategories(activeGroupId) });
  const membersQuery = useQuery({ queryKey: ['members', activeGroupId], queryFn: () => api.getMembers(activeGroupId) });
  const compact = useMediaQuery('(max-width: 1023px)');
  const [categoryId, setCategoryId] = useState('');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const activeMembers = useMemo(() => membersQuery.data?.filter((member) => member.active) ?? [], [membersQuery.data]);
  const bookableCategories = useMemo(() => getBookableCategories(categoriesQuery.data ?? []), [categoriesQuery.data]);
  const selectedProduct = useMemo(() => {
    const products = bookableCategories.flatMap((category) => category.products);
    return products.find((product) => product.id === selectedProductId);
  }, [bookableCategories, selectedProductId]);
  const selectedCategory = bookableCategories.find((category) => category.id === selectedProduct?.categoryId);
  const currentMembership = activeMembers.find((member) => member.userId === session.user.id) ?? activeMembers[0];
  const hasBookableProducts = bookableCategories.some((category) => category.products.length > 0);
  const activeRoles = session.groups.find((group) => group.id === activeGroupId)?.membership?.roles ?? [];
  const canManageCatalog = hasGroupCapability(activeRoles, 'catalog');

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

  if (dashboardQuery.isLoading || categoriesQuery.isLoading || membersQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (!dashboardQuery.data || !categoriesQuery.data || !membersQuery.data || !currentMembership) {
    return <div className={styles.state}><StatePanel kind="error" message={t('booking.productsError')} /></div>;
  }
  if (!hasBookableProducts) {
    return <div className={styles.state}><StatePanel kind="empty" title={t('booking.noProductsTitle')} message={t('booking.noProductsMessage')}>{canManageCatalog ? <Link className={styles.catalogLink} to={memberPaths.catalog}>{t('booking.catalogLink')}</Link> : null}</StatePanel></div>;
  }

  const inspector = selectedProduct && selectedCategory ? (
    <BookingInspector
      compact
      currentMembershipId={currentMembership.id}
      groupId={activeGroupId}
      key={selectedProduct.id}
      members={activeMembers}
      onBooked={clearSelection}
      onCancel={clearSelection}
      period={dashboardQuery.data.currentPeriod}
      product={selectedProduct}
    />
  ) : null;

  return (
    <div className={styles.layout}>
      <section className={styles.content}>
        <h1>{t('booking.quickTitle')}</h1>
        <div className={styles.balance}>
          <div><span>{t('booking.openBalance')}</span><strong>{formatMoney(dashboardQuery.data.openBalance)}</strong></div>
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
      {!compact && selectedProduct && inspector ? <aside className={styles.inspector}><h2>{t('booking.productTitle', { name: selectedProduct.name })}</h2>{inspector}</aside> : null}
      {compact && selectedProduct && inspector ? (
        <Modal onClose={clearSelection} open={sheetOpen} title={t('booking.productTitle', { name: selectedProduct.name })} variant="sheet">
          {inspector}
        </Modal>
      ) : null}
    </div>
  );
}
