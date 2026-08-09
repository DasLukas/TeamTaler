import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney, isCreditBalance } from '@/api/money';
import { canRecordOwnPayment } from '@/app/groupCapabilities';
import { can } from '@/app/permissions';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Avatar } from '@/components/ui/Avatar';
import { StatePanel } from '@/components/ui/StatePanel';
import { CategoryIcon } from '@/features/shared/CategoryIcon';
import { SelfPaymentDialog } from '@/features/finance/SelfPaymentDialog';
import { getDashboardGreetingKey } from './greeting';
import { GroupStatisticsSection } from './GroupStatisticsSection';
import styles from './DashboardPage.module.css';

/**
 * Tracks the browser's local hour while the dashboard remains mounted.
 *
 * @returns The current local hour, refreshed every minute and on tab visibility changes.
 */
function useLocalHour(): number {
  const [hour, setHour] = useState(() => new Date().getHours());

  useEffect(() => {
    const updateHour = () => setHour(new Date().getHours());
    const interval = window.setInterval(updateHour, 60_000);
    document.addEventListener('visibilitychange', updateHour);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', updateHour);
    };
  }, []);

  return hour;
}

/**
 * Renders the member overview without exposing booking controls.
 *
 * @returns Personal summaries, recent activity, and anonymous group statistics.
 */
export function DashboardPage() {
  const { t } = useTranslation();
  const { activeGroupId, activeGroup, session } = useActiveGroup();
  const dashboardQuery = useQuery({ queryKey: ['dashboard', activeGroupId], queryFn: () => api.getDashboard(activeGroupId) });
  const localHour = useLocalHour();

  if (dashboardQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (dashboardQuery.error || !dashboardQuery.data) {
    return <div className={styles.state}><StatePanel kind="error" message={t('dashboard.error')} /></div>;
  }

  const dashboard = dashboardQuery.data;
  const recentBookings = dashboard.recentBookings;
  const periodTotal = dashboard.categoryTotals.reduce((sum, entry) => sum + BigInt(entry.total.minorUnits), 0n);
  const greeting = t(`dashboard.${getDashboardGreetingKey(localHour)}`);
  const canRecordPayment = canRecordOwnPayment(activeGroup.membership?.effectiveGrants);
  const canViewGroupStatistics = can(activeGroup.membership?.effectiveGrants, 'VIEW_GROUP_STATISTICS');
  const hasCreditBalance = isCreditBalance(dashboard.openBalance);

  return (
    <div className={styles.dashboard}>
      <section className={styles.content}>
        <h1>{greeting}, {session.user.displayName.split(' ')[0]}</h1>
        <div className={styles.balanceCard}>
          <div><span>{t('booking.openBalance')}</span><strong className={hasCreditBalance ? styles.creditBalance : undefined} data-financial-state={hasCreditBalance ? 'credit' : 'due'}>{formatMoney(dashboard.openBalance)}</strong>{canRecordPayment ? <SelfPaymentDialog className={styles.selfPaymentAction} openBalance={dashboard.openBalance} /> : null}</div>
          <div className={styles.period}><strong>{t('dashboard.settlement', { label: dashboard.currentPeriod.label.split(' ')[0] })}</strong><p>{t(canRecordPayment ? 'dashboard.paymentNoteSelf' : 'dashboard.paymentNote')}</p></div>
        </div>

        <div className={styles.lower}>
          <section>
            <h2>{t('dashboard.recentActivities')}</h2>
            <div className={styles.activityList}>
              {recentBookings.slice(0, 3).map((booking) => (
                <Link className={styles.activity} key={booking.id} to="/activities">
                  <Avatar name={booking.memberName} size="small" src={booking.memberAvatarUrl} />
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
          <section className={styles.periodSection}>
            <h2>{dashboard.currentPeriod.label}</h2>
            <div className={styles.monthCard}>
              {dashboard.categoryTotals.map((entry) => {
                return <div className={styles.totalRow} key={entry.categoryId}><CategoryIcon icon={entry.icon} size={24} /><span>{entry.categoryName}</span><strong>{formatMoney(entry.total)}</strong></div>;
              })}
              <div className={styles.sum}><span>{t('dashboard.sum')}</span><strong>{formatMoney({ minorUnits: periodTotal.toString(), currency: dashboard.openBalance.currency })}</strong></div>
            </div>
          </section>
        </div>
        {canViewGroupStatistics ? <GroupStatisticsSection currency={dashboard.openBalance.currency} groupTotals={dashboard.groupCategoryTotals} periodLabel={dashboard.currentPeriod.label} /> : null}
      </section>
    </div>
  );
}
