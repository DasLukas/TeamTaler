import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right';
import Gavel from 'lucide-react/dist/esm/icons/gavel';
import GlassWater from 'lucide-react/dist/esm/icons/glass-water';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney } from '@/api/money';
import type { Product } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Avatar } from '@/components/ui/Avatar';
import { Modal } from '@/components/ui/Modal';
import { StatePanel } from '@/components/ui/StatePanel';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { BookingInspector } from '@/features/bookings/BookingInspector';
import { ProductPicker } from '@/features/bookings/ProductPicker';
import { getBookableCategories } from '@/features/bookings/bookable';
import styles from './DashboardPage.module.css';

/**
 * Renders the member dashboard and high-speed booking workspace.
 *
 * @returns Dashboard summaries, product choices, and booking controls.
 */
export function DashboardPage() {
  const { t } = useTranslation();
  const { activeGroupId, session } = useActiveGroup();
  const dashboardQuery = useQuery({ queryKey: ['dashboard', activeGroupId], queryFn: () => api.getDashboard(activeGroupId) });
  const categoriesQuery = useQuery({ queryKey: ['categories', activeGroupId], queryFn: () => api.getCategories(activeGroupId) });
  const membersQuery = useQuery({ queryKey: ['members', activeGroupId], queryFn: () => api.getMembers(activeGroupId) });
  const compactInspector = useMediaQuery('(max-width: 1199px)');
  const [categoryId, setCategoryId] = useState('');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const bookableCategories = useMemo(() => getBookableCategories(categoriesQuery.data ?? []), [categoriesQuery.data]);

  const selectedProduct = useMemo(() => {
    const products = bookableCategories.flatMap((category) => category.products);
    return products.find((product) => product.id === selectedProductId) ?? products.find((product) => product.name.toLocaleLowerCase('de') === 'bier') ?? products[0];
  }, [bookableCategories, selectedProductId]);
  const selectedCategory = bookableCategories.find((category) => category.id === selectedProduct?.categoryId);
  const currentMembership = membersQuery.data?.find((member) => member.userId === session.user.id) ?? membersQuery.data?.[0];
  const loading = dashboardQuery.isLoading || categoriesQuery.isLoading || membersQuery.isLoading;
  const error = dashboardQuery.error ?? categoriesQuery.error ?? membersQuery.error;

  const chooseProduct = (product: Product) => {
    setSelectedProductId(product.id);
    if (compactInspector) setInspectorOpen(true);
  };
  const changeCategory = (nextCategoryId: string) => {
    setCategoryId(nextCategoryId);
    setSelectedProductId(bookableCategories.find((category) => category.id === nextCategoryId)?.products[0]?.id ?? '');
  };

  if (loading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (error || !dashboardQuery.data || !categoriesQuery.data || !membersQuery.data || !currentMembership) {
    return <div className={styles.state}><StatePanel kind="error" message={t('dashboard.error')} /></div>;
  }

  const dashboard = dashboardQuery.data;
  const recentBookings = dashboard.recentBookings.map((booking) => ({
    ...booking,
    memberName: membersQuery.data.find((member) => member.id === booking.memberId)?.displayName ?? booking.memberName,
    bookedByName: membersQuery.data.find((member) => member.id === booking.bookedByMemberId)?.displayName ?? booking.bookedByName,
  }));
  const periodTotal = dashboard.categoryTotals.reduce((sum, entry) => sum + BigInt(entry.total.minorUnits), 0n);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? t('dashboard.morning') : hour < 18 ? t('dashboard.day') : t('dashboard.evening');

  const inspector = selectedProduct && selectedCategory ? (
    <BookingInspector
      categoryType={selectedCategory.type}
      currentMembershipId={currentMembership.id}
      groupId={activeGroupId}
      key={selectedProduct.id}
      members={membersQuery.data}
      onBooked={() => setInspectorOpen(false)}
      onCancel={() => setInspectorOpen(false)}
      period={dashboard.currentPeriod}
      product={selectedProduct}
    />
  ) : null;

  return (
    <div className={styles.dashboard}>
      <section className={styles.content}>
        <h1>{greeting}, {session.user.displayName.split(' ')[0]}</h1>
        <div className={styles.balanceCard}>
          <div><span>{t('booking.openBalance')}</span><strong>{formatMoney(dashboard.openBalance)}</strong></div>
          <div className={styles.period}><strong>{t('dashboard.settlement', { label: dashboard.currentPeriod.label.split(' ')[0] })}</strong><p>{t('dashboard.paymentNote')}</p></div>
        </div>

        <section className={styles.quick}>
          <h2>{t('booking.quickTitle')}</h2>
          <ProductPicker
            categories={bookableCategories}
            onCategoryChange={changeCategory}
            onProductSelect={chooseProduct}
            selectedCategoryId={categoryId || selectedProduct?.categoryId || bookableCategories[0]?.id || ''}
            selectedProductId={selectedProduct?.id}
          />
        </section>

        <div className={styles.lower}>
          <section>
            <h2>{t('dashboard.recentActivities')}</h2>
            <div className={styles.activityList}>
              {recentBookings.slice(0, 3).map((booking) => (
                <Link className={styles.activity} key={booking.id} to="/activities">
                  <Avatar name={booking.memberName} size="small" />
                  <div className={styles.activityCopy}>
                    <span><strong>{booking.memberName.split(' ')[0]}</strong> · {booking.productName} · {formatMoney(booking.total)}</span>
                    {booking.bookedByName !== booking.memberName ? <small>{t('activities.bookedByCue', { name: booking.bookedByName })}</small> : null}
                  </div>
                  <time>{new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(new Date(booking.bookedAt))}</time>
                  <ChevronRight aria-hidden="true" size={18} />
                </Link>
              ))}
              <Link className={styles.allActivities} to="/activities">{t('dashboard.allActivities')} <ChevronRight size={18} /></Link>
            </div>
          </section>
          <section className={styles.monthCard}>
            <h2>{dashboard.currentPeriod.label}</h2>
            {dashboard.categoryTotals.map((entry) => {
              const Icon = entry.icon === 'drink' ? GlassWater : Gavel;
              return <div className={styles.totalRow} key={entry.categoryId}><Icon size={24} /><span>{entry.categoryName}</span><strong>{formatMoney(entry.total)}</strong></div>;
            })}
            <div className={styles.sum}><span>{t('dashboard.sum')}</span><strong>{formatMoney({ minorUnits: periodTotal.toString(), currency: dashboard.openBalance.currency })}</strong></div>
          </section>
        </div>
      </section>

      {!compactInspector && inspector ? (
        <aside className={styles.inspector}>
          <h2>{t('booking.panelTitle')}</h2>
          {inspector}
        </aside>
      ) : null}
      {compactInspector && selectedProduct ? (
        <Modal className={styles.bookingModal} onClose={() => setInspectorOpen(false)} open={inspectorOpen} title={t('booking.productTitle', { name: selectedProduct.name })} variant="sheet">
          {inspector}
        </Modal>
      ) : null}
    </div>
  );
}
