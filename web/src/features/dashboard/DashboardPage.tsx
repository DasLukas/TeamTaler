import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney } from '@/api/money';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Avatar } from '@/components/ui/Avatar';
import { StatePanel } from '@/components/ui/StatePanel';
import { CategoryIcon } from '@/features/shared/CategoryIcon';
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
  const { activeGroupId, session } = useActiveGroup();
  const dashboardQuery = useQuery({ queryKey: ['dashboard', activeGroupId], queryFn: () => api.getDashboard(activeGroupId) });
  const membersQuery = useQuery({ queryKey: ['members', activeGroupId], queryFn: () => api.getMembers(activeGroupId) });
  const localHour = useLocalHour();
  const loading = dashboardQuery.isLoading || membersQuery.isLoading;
  const error = dashboardQuery.error ?? membersQuery.error;

  if (loading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (error || !dashboardQuery.data || !membersQuery.data) {
    return <div className={styles.state}><StatePanel kind="error" message={t('dashboard.error')} /></div>;
  }

  const dashboard = dashboardQuery.data;
  const membersByID = new Map(membersQuery.data.map((member) => [member.id, member]));
  const recentBookings = dashboard.recentBookings.map((booking) => {
    const target = membersByID.get(booking.memberId);
    const actor = booking.bookedByMemberId ? membersByID.get(booking.bookedByMemberId) : undefined;
    return {
      ...booking,
      memberName: target?.displayName ?? booking.memberName,
      memberAvatarUrl: target?.avatarUrl ?? booking.memberAvatarUrl,
      bookedByName: actor?.displayName ?? booking.bookedByName,
      bookedByAvatarUrl: actor?.avatarUrl ?? booking.bookedByAvatarUrl,
    };
  });
  const periodTotal = dashboard.categoryTotals.reduce((sum, entry) => sum + BigInt(entry.total.minorUnits), 0n);
  const greeting = t(`dashboard.${getDashboardGreetingKey(localHour)}`);

  return (
    <div className={styles.dashboard}>
      <section className={styles.content}>
        <h1>{greeting}, {session.user.displayName.split(' ')[0]}</h1>
        <div className={styles.balanceCard}>
          <div><span>{t('booking.openBalance')}</span><strong>{formatMoney(dashboard.openBalance)}</strong></div>
          <div className={styles.period}><strong>{t('dashboard.settlement', { label: dashboard.currentPeriod.label.split(' ')[0] })}</strong><p>{t('dashboard.paymentNote')}</p></div>
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
          <section className={styles.monthCard}>
            <h2>{dashboard.currentPeriod.label}</h2>
            {dashboard.categoryTotals.map((entry) => {
              return <div className={styles.totalRow} key={entry.categoryId}><CategoryIcon icon={entry.icon} size={24} /><span>{entry.categoryName}</span><strong>{formatMoney(entry.total)}</strong></div>;
            })}
            <div className={styles.sum}><span>{t('dashboard.sum')}</span><strong>{formatMoney({ minorUnits: periodTotal.toString(), currency: dashboard.openBalance.currency })}</strong></div>
          </section>
        </div>
        <GroupStatisticsSection currency={dashboard.openBalance.currency} groupTotals={dashboard.groupCategoryTotals} periodLabel={dashboard.currentPeriod.label} />
      </section>
    </div>
  );
}
