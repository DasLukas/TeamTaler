import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { StatePanel } from '@/components/ui/StatePanel';
import { AuditPanel } from './AuditPanel';
import { CatalogPanel } from './CatalogPanel';
import { FinancePanel } from './FinancePanel';
import { MembersPanel } from './MembersPanel';
import { PeriodsPanel } from './PeriodsPanel';
import { RightsPanel } from './RightsPanel';
import styles from './AdminPage.module.css';

type AdminTab = 'members' | 'rights' | 'catalog' | 'finance' | 'periods' | 'audit';

const tabs: Array<{ id: AdminTab; labelKey: string; capability: 'admin' | 'catalog' | 'finance' }> = [
  { id: 'members', labelKey: 'admin.tabs.members', capability: 'admin' },
  { id: 'rights', labelKey: 'admin.tabs.rights', capability: 'admin' },
  { id: 'catalog', labelKey: 'admin.tabs.catalog', capability: 'catalog' },
  { id: 'finance', labelKey: 'admin.tabs.finance', capability: 'finance' },
  { id: 'periods', labelKey: 'admin.tabs.periods', capability: 'finance' },
  { id: 'audit', labelKey: 'admin.tabs.audit', capability: 'admin' },
];

/**
 * Renders the role-aware administrative workspace.
 *
 * @returns Membership, permission, catalogue, finance, period, or audit tools.
 */
export function AdminPage() {
  const { t } = useTranslation();
  const { activeGroup } = useActiveGroup();
  const roles = activeGroup.membership?.roles ?? [];
  const isAdmin = roles.includes('ADMIN');
  const availableTabs = tabs.filter((tab) => isAdmin || tab.capability === 'catalog' && roles.includes('CATALOG_MANAGER') || tab.capability === 'finance' && roles.includes('FINANCE_MANAGER'));
  const [requestedTab, setRequestedTab] = useState<AdminTab>('rights');
  const activeTab = availableTabs.some((tab) => tab.id === requestedTab) ? requestedTab : availableTabs[0]?.id;
  if (!activeTab) return <Page title={t('admin.title')}><StatePanel kind="error" title={t('admin.noAccessTitle')} message={t('admin.noAccessMessage')} /></Page>;
  return (
    <Page className={styles.page} title={t('admin.title')} wide>
      <div aria-label={t('admin.areas')} className={styles.tabs} role="tablist">
        {availableTabs.map((tab) => <button aria-selected={activeTab === tab.id} className={activeTab === tab.id ? styles.activeTab : ''} key={tab.id} onClick={() => setRequestedTab(tab.id)} role="tab" type="button">{t(tab.labelKey)}</button>)}
      </div>
      <section aria-label={t(availableTabs.find((tab) => tab.id === activeTab)?.labelKey ?? 'admin.title')} className={styles.panel} role="tabpanel">
        {activeTab === 'members' ? <MembersPanel /> : null}
        {activeTab === 'rights' ? <RightsPanel /> : null}
        {activeTab === 'catalog' ? <CatalogPanel /> : null}
        {activeTab === 'finance' ? <FinancePanel /> : null}
        {activeTab === 'periods' ? <PeriodsPanel /> : null}
        {activeTab === 'audit' ? <AuditPanel /> : null}
      </section>
    </Page>
  );
}
