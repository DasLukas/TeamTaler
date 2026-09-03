import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney } from '@/api/money';
import { canRecordOwnPayment, canUsePlanning } from '@/app/groupCapabilities';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Avatar } from '@/components/ui/Avatar';
import { StatePanel } from '@/components/ui/StatePanel';
import { SelfPaymentDialog } from '@/features/finance/SelfPaymentDialog';
import { getDashboardGreetingKey } from './greeting';
import { GroupBalanceCard } from './GroupBalanceCard';
import { planningKeys } from '@/features/planning/planningQueryKeys';
import { PlanningEventCard } from '@/features/planning/PlanningEventCard';
import { formatPlanningEventSchedule } from '@/features/planning/planningTiming';
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
 * @returns Personal balance, recent activity, and the permission-gated group balance.
 */
export function DashboardPage() {
  const { t } = useTranslation();
  const { activeGroupId, activeGroup, session } = useActiveGroup();
  const dashboardQuery = useQuery({ queryKey: ['dashboard', activeGroupId], queryFn: () => api.getDashboard(activeGroupId) });
  const transactionSettingsQuery = useQuery({ queryKey: ['transaction-settings', activeGroupId], queryFn: () => api.getTransactionSettings(activeGroupId) });
  const planningAvailable = Boolean(activeGroup.planningEnabled && canUsePlanning(activeGroup.membership?.effectiveGrants));
  const planningCardAvailable = Boolean(planningAvailable && dashboardQuery.data?.planningEnabled && dashboardQuery.data.planning);
  const planningSettingsQuery = useQuery({ queryKey: planningKeys.settings(activeGroupId), queryFn: () => api.getPlanningSettings(activeGroupId), enabled: planningCardAvailable, staleTime: 60_000 });
  const localHour = useLocalHour();

  if (dashboardQuery.isLoading || transactionSettingsQuery.isLoading || planningCardAvailable && planningSettingsQuery.isLoading) return <div className={styles.state}><StatePanel kind="loading" /></div>;
  if (dashboardQuery.error || transactionSettingsQuery.error || planningCardAvailable && planningSettingsQuery.error || !dashboardQuery.data || !transactionSettingsQuery.data) {
    return <div className={styles.state}><StatePanel kind="error" message={t('dashboard.error')} /></div>;
  }

  const dashboard = dashboardQuery.data;
  const settlementsEnabled = transactionSettingsQuery.data.settlementsEnabled;
  const recentBookings = dashboard.recentBookings;
  const greeting = t(`dashboard.${getDashboardGreetingKey(localHour)}`);
  const canRecordPayment = canRecordOwnPayment(activeGroup.membership?.effectiveGrants);
  const openBalanceAmount = BigInt(dashboard.openBalance.minorUnits);
  const openBalanceState = openBalanceAmount > 0n ? 'due' : openBalanceAmount < 0n ? 'credit' : 'balanced';
  // The API omits this field unless the statistics feature and VIEW_STATISTICS
  // are effective. Using the response as the single authorization projection avoids hiding a newly
  // granted balance while locally cached membership grants are still stale.
  const groupOutstanding = dashboard.groupOutstanding;
  const showGroupBalance = groupOutstanding !== undefined;

  return (
    <div className={styles.dashboard}>
      <section className={styles.content}>
        <h1>{greeting}, {session.user.displayName.split(' ')[0]}</h1>
        <section className={styles.personalBalanceSection}>
          <h2>{t('booking.openBalance')}</h2>
          <div className={`${styles.balanceCard} ${settlementsEnabled ? '' : styles.continuousBalanceCard}`}>
            <div><strong className={openBalanceState === 'due' ? undefined : styles.nonDueBalance} data-financial-state={openBalanceState}>{formatMoney(dashboard.openBalance)}</strong>{canRecordPayment ? <SelfPaymentDialog className={styles.selfPaymentAction} openBalance={dashboard.openBalance} /> : null}</div>
            <div className={styles.period}>{settlementsEnabled ? <strong>{t('dashboard.settlement', { label: dashboard.currentPeriod.label.split(' ')[0] })}</strong> : null}<p>{t(canRecordPayment ? 'dashboard.paymentNoteSelf' : 'dashboard.paymentNote')}</p></div>
          </div>
        </section>

        <div className={`${styles.lower} ${showGroupBalance ? '' : styles.lowerSingle}`}>
          <section>
            <h2>{t('dashboard.recentActivities')}</h2>
            <div className={styles.activityList}>
              {recentBookings.slice(0, 3).map((booking) => (
                <Link className={styles.activity} key={booking.id} to="/activities">
                  <Avatar name={booking.memberName} size="small" src={booking.memberAvatarUrl} />
                  <div className={styles.activityCopy}>
                    <span><strong>{booking.memberName.split(' ')[0]}</strong>{booking.memberStatus === 'DELETED' ? <em className={styles.deletedBadge}>{t('common.deleted')}</em> : null} · {booking.productName} · {formatMoney(booking.total)}</span>
                    {booking.bookedByName !== booking.memberName ? <small>{t('activities.bookedByCue', { name: booking.bookedByName })}{booking.bookedByStatus === 'DELETED' ? <em className={styles.deletedBadge}>{t('common.deleted')}</em> : null}</small> : null}
                  </div>
                  <time>{new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(new Date(booking.bookedAt))}</time>
                  <ChevronRight aria-hidden="true" size={18} />
                </Link>
              ))}
              <Link className={styles.allActivities} to="/activities">{t('dashboard.allActivities')} <ChevronRight size={18} /></Link>
            </div>
          </section>
          {groupOutstanding !== undefined ? <GroupBalanceCard balance={groupOutstanding} /> : null}
        </div>
        {dashboard.planningEnabled && dashboard.planning ? <PlanningEventCard
          className={styles.planningPreview}
          event={dashboard.planning.event}
          navigationSearch={{ view: 'week' }}
          scheduleLabel={formatPlanningEventSchedule(dashboard.planning.event, dashboard.planning.event.timeZone ?? planningSettingsQuery.data?.timeZone ?? 'UTC', t('planning.allDay'))}
          showParticipation={dashboard.planning.actionRequired}
          timeZone={dashboard.planning.event.timeZone ?? planningSettingsQuery.data?.timeZone ?? 'UTC'}
        /> : null}
      </section>
    </div>
  );
}
