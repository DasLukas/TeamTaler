import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { can } from '@/app/permissions';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { StatePanel } from '@/components/ui/StatePanel';
import { AccountBalancesPanel } from './AccountBalancesPanel';
import { PaymentsPanel } from './PaymentsPanel';
import { SettlementsPanel } from './SettlementsPanel';
import styles from './FinancePage.module.css';

const ExternalAccountsPanel = lazy(() => import('@/features/externalAccounts/ExternalAccountsPanel').then((module) => ({ default: module.ExternalAccountsPanel })));

type FinanceTab = 'overview' | 'payments' | 'settlements' | 'external-accounts';

const coreTabs: Array<{ id: FinanceTab; labelKey: string }> = [
  { id: 'overview', labelKey: 'financeWorkspace.tabs.overview' },
  { id: 'payments', labelKey: 'financeWorkspace.tabs.payments' },
];

/**
 * Renders the finance-manager workspace with a query-safe role guard.
 *
 * @returns Finance tabs for authorized memberships or a neutral no-access state.
 */
export function FinancePage() {
  const { t } = useTranslation();
  const { activeGroup, activeGroupId } = useActiveGroup();
  const [requestedTab, setRequestedTab] = useState<FinanceTab>(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    return requested === 'payments' || requested === 'settlements' || requested === 'external-accounts' ? requested : 'overview';
  });
  const grants = activeGroup.membership?.effectiveGrants;
  const canManageFinance = can(grants, 'FINANCE_MANAGEMENT');
  const canViewExternalAccounts = activeGroup.externalAccountsEnabled && can(grants, 'VIEW_EXTERNAL_ACCOUNTS');
  const transactionSettingsQuery = useQuery({ queryKey: ['transaction-settings', activeGroupId], queryFn: () => api.getTransactionSettings(activeGroupId), enabled: canManageFinance });
  const settlementsQuery = useQuery({ queryKey: ['settlements', activeGroupId], queryFn: () => api.getSettlements(activeGroupId), enabled: canManageFinance });

  if (!canManageFinance && !canViewExternalAccounts) {
    return <Page title={t('financeWorkspace.title')}><StatePanel kind="error" title={t('financeWorkspace.noAccessTitle')} message={t('financeWorkspace.noAccessMessage')} /></Page>;
  }
  if (canManageFinance && (transactionSettingsQuery.isLoading || settlementsQuery.isLoading)) return <Page title={t('financeWorkspace.title')}><StatePanel kind="loading" /></Page>;
  if (canManageFinance && (transactionSettingsQuery.isError || settlementsQuery.isError || !transactionSettingsQuery.data || !settlementsQuery.data)) return <Page title={t('financeWorkspace.title')}><StatePanel kind="error" message={t('finance.error')} /></Page>;

  const settlementsEnabled = transactionSettingsQuery.data?.settlementsEnabled ?? false;
  const hasSettlementHistory = (settlementsQuery.data?.length ?? 0) > 0;
  const tabs: Array<{ id: FinanceTab; labelKey: string }> = [
    ...(canManageFinance ? coreTabs : []),
    ...(canManageFinance && (settlementsEnabled || hasSettlementHistory) ? [{ id: 'settlements' as const, labelKey: settlementsEnabled ? 'financeWorkspace.tabs.settlements' : 'financeWorkspace.tabs.settlementHistory' }] : []),
    ...(canViewExternalAccounts ? [{ id: 'external-accounts' as const, labelKey: 'financeWorkspace.tabs.externalAccounts' }] : []),
  ];
  const activeTab = tabs.some((tab) => tab.id === requestedTab) ? requestedTab : tabs[0].id;
  const selectTab = (tab: FinanceTab) => {
    setRequestedTab(tab);
    const search = new URLSearchParams(window.location.search);
    search.set('tab', tab);
    if (tab !== 'payments') search.delete('paymentId');
    window.history.replaceState(window.history.state, '', `${window.location.pathname}?${search.toString()}`);
  };

  return (
    <Page className={styles.page} title={t('financeWorkspace.title')} wide>
      <div aria-label={t('financeWorkspace.areas')} className={styles.tabs} role="tablist">
        {tabs.map((tab) => <button aria-selected={activeTab === tab.id} className={activeTab === tab.id ? styles.activeTab : ''} key={tab.id} onClick={() => selectTab(tab.id)} role="tab" type="button">{t(tab.labelKey)}</button>)}
      </div>
      <section aria-label={t(tabs.find((tab) => tab.id === activeTab)?.labelKey ?? 'financeWorkspace.title')} className={styles.panel} role="tabpanel">
        {activeTab === 'overview' ? <AccountBalancesPanel /> : null}
        {activeTab === 'payments' ? <PaymentsPanel /> : null}
        {activeTab === 'settlements' && settlementsQuery.data ? <SettlementsPanel settlements={settlementsQuery.data} settlementsEnabled={settlementsEnabled} /> : null}
        {activeTab === 'external-accounts' ? <Suspense fallback={<StatePanel kind="loading" />}><ExternalAccountsPanel /></Suspense> : null}
      </section>
    </Page>
  );
}
