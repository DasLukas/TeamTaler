import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { hasGroupCapability } from '@/app/groupCapabilities';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { StatePanel } from '@/components/ui/StatePanel';
import { AccountBalancesPanel } from './AccountBalancesPanel';
import { PaymentsPanel } from './PaymentsPanel';
import { SettlementsPanel } from './SettlementsPanel';
import styles from './FinancePage.module.css';

type FinanceTab = 'overview' | 'payments' | 'settlements';

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
  const [requestedTab, setRequestedTab] = useState<FinanceTab>('overview');
  const canManageFinance = hasGroupCapability(activeGroup.membership?.effectiveGrants, 'finance');
  const transactionSettingsQuery = useQuery({ queryKey: ['transaction-settings', activeGroupId], queryFn: () => api.getTransactionSettings(activeGroupId), enabled: canManageFinance });
  const settlementsQuery = useQuery({ queryKey: ['settlements', activeGroupId], queryFn: () => api.getSettlements(activeGroupId), enabled: canManageFinance });

  if (!canManageFinance) {
    return <Page title={t('financeWorkspace.title')}><StatePanel kind="error" title={t('financeWorkspace.noAccessTitle')} message={t('financeWorkspace.noAccessMessage')} /></Page>;
  }
  if (transactionSettingsQuery.isLoading || settlementsQuery.isLoading) return <Page title={t('financeWorkspace.title')}><StatePanel kind="loading" /></Page>;
  if (transactionSettingsQuery.isError || settlementsQuery.isError || !transactionSettingsQuery.data || !settlementsQuery.data) return <Page title={t('financeWorkspace.title')}><StatePanel kind="error" message={t('finance.error')} /></Page>;

  const settlementsEnabled = transactionSettingsQuery.data.settlementsEnabled;
  const hasSettlementHistory = settlementsQuery.data.length > 0;
  const tabs = settlementsEnabled || hasSettlementHistory
    ? [...coreTabs, { id: 'settlements' as const, labelKey: settlementsEnabled ? 'financeWorkspace.tabs.settlements' : 'financeWorkspace.tabs.settlementHistory' }]
    : coreTabs;
  const activeTab = tabs.some((tab) => tab.id === requestedTab) ? requestedTab : 'overview';

  return (
    <Page className={styles.page} title={t('financeWorkspace.title')} wide>
      <div aria-label={t('financeWorkspace.areas')} className={styles.tabs} role="tablist">
        {tabs.map((tab) => <button aria-selected={activeTab === tab.id} className={activeTab === tab.id ? styles.activeTab : ''} key={tab.id} onClick={() => setRequestedTab(tab.id)} role="tab" type="button">{t(tab.labelKey)}</button>)}
      </div>
      <section aria-label={t(tabs.find((tab) => tab.id === activeTab)?.labelKey ?? 'financeWorkspace.title')} className={styles.panel} role="tabpanel">
        {activeTab === 'overview' ? <AccountBalancesPanel /> : null}
        {activeTab === 'payments' ? <PaymentsPanel /> : null}
        {activeTab === 'settlements' ? <SettlementsPanel settlements={settlementsQuery.data} settlementsEnabled={settlementsEnabled} /> : null}
      </section>
    </Page>
  );
}
