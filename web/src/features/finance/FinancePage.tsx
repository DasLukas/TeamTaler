import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hasGroupCapability } from '@/app/groupCapabilities';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { StatePanel } from '@/components/ui/StatePanel';
import { AccountBalancesPanel } from './AccountBalancesPanel';
import { PaymentsPanel } from './PaymentsPanel';
import { SettlementsPanel } from './SettlementsPanel';
import styles from './FinancePage.module.css';

type FinanceTab = 'overview' | 'payments' | 'settlements';

const tabs: Array<{ id: FinanceTab; labelKey: string }> = [
  { id: 'overview', labelKey: 'financeWorkspace.tabs.overview' },
  { id: 'payments', labelKey: 'financeWorkspace.tabs.payments' },
  { id: 'settlements', labelKey: 'financeWorkspace.tabs.settlements' },
];

/**
 * Renders the finance-manager workspace with a query-safe role guard.
 *
 * @returns Finance tabs for authorized memberships or a neutral no-access state.
 */
export function FinancePage() {
  const { t } = useTranslation();
  const { activeGroup } = useActiveGroup();
  const [activeTab, setActiveTab] = useState<FinanceTab>('overview');
  const roles = activeGroup.membership?.roles ?? [];
  const canManageFinance = hasGroupCapability(roles, 'finance');

  if (!canManageFinance) {
    return <Page title={t('financeWorkspace.title')}><StatePanel kind="error" title={t('financeWorkspace.noAccessTitle')} message={t('financeWorkspace.noAccessMessage')} /></Page>;
  }

  return (
    <Page className={styles.page} title={t('financeWorkspace.title')} wide>
      <div aria-label={t('financeWorkspace.areas')} className={styles.tabs} role="tablist">
        {tabs.map((tab) => <button aria-selected={activeTab === tab.id} className={activeTab === tab.id ? styles.activeTab : ''} key={tab.id} onClick={() => setActiveTab(tab.id)} role="tab" type="button">{t(tab.labelKey)}</button>)}
      </div>
      <section aria-label={t(tabs.find((tab) => tab.id === activeTab)?.labelKey ?? 'financeWorkspace.title')} className={styles.panel} role="tabpanel">
        {activeTab === 'overview' ? <AccountBalancesPanel /> : null}
        {activeTab === 'payments' ? <PaymentsPanel /> : null}
        {activeTab === 'settlements' ? <SettlementsPanel /> : null}
      </section>
    </Page>
  );
}
