import { lazy, Suspense, type KeyboardEvent, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { can } from '@/app/permissions';
import { useOptionalActiveGroup } from '@/app/useActiveGroup';
import { isSystemAdministrator, useSession } from '@/app/useSession';
import { Page } from '@/components/layout/Page';
import { StatePanel } from '@/components/ui/StatePanel';
import tabStyles from '@/components/ui/WorkspaceTabs.module.css';
import { DataExportPanel } from '@/features/exports/DataExportPanel';
import { AuditPanel } from './AuditPanel';
import { BehaviorSettingsPanel } from './BehaviorSettingsPanel';
import { MembersPanel } from './MembersPanel';
import { RightsPanel } from './RightsPanel';
import styles from './AdminPage.module.css';

const SystemSettingsPanel = lazy(() => import('./SystemSettingsPanel').then((module) => ({ default: module.SystemSettingsPanel })));

type AdminTab = 'system' | 'settings' | 'members' | 'rights' | 'audit' | 'exports';

const tabs: Array<{ id: AdminTab; labelKey: string }> = [
  { id: 'system', labelKey: 'admin.tabs.system' },
  { id: 'settings', labelKey: 'admin.tabs.settings' },
  { id: 'members', labelKey: 'admin.tabs.members' },
  { id: 'rights', labelKey: 'admin.tabs.rights' },
  { id: 'audit', labelKey: 'admin.tabs.audit' },
  { id: 'exports', labelKey: 'admin.tabs.exports' },
];

/**
 * Renders the role-aware administrative workspace.
 *
 * @returns Membership, permission, group, or audit tools.
 */
export function AdminPage() {
  const { t } = useTranslation();
  const session = useSession();
  const groupContext = useOptionalActiveGroup();
  const activeGroup = groupContext?.activeGroup;
  const systemAdministrator = isSystemAdministrator(session);
  const grants = activeGroup?.membership?.effectiveGrants;
  const canManageGroup = can(grants, 'GROUP_ADMINISTRATION');
  const canManageMembers = can(grants, 'MEMBER_MANAGEMENT');
  const canManageRoles = can(grants, 'ROLE_MANAGEMENT');
  const canManageFinances = can(grants, 'FINANCE_MANAGEMENT');
  const tabGroupId = useId();
  const tabRefs = useRef<Partial<Record<AdminTab, HTMLButtonElement | null>>>({});
  const [requestedTab, setRequestedTab] = useState<AdminTab>(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    if (requested && tabs.some((tab) => tab.id === requested)) return requested as AdminTab;
    return systemAdministrator ? 'system' : 'settings';
  });
  const availableTabs = tabs.filter((tab) => {
    if (tab.id === 'system') return systemAdministrator;
    if (!activeGroup) return false;
    if (tab.id === 'rights') return canManageRoles;
    if (tab.id === 'exports') return canManageGroup;
    if (tab.id === 'members') return canManageMembers;
    if (tab.id === 'settings') return canManageGroup || canManageRoles || canManageFinances;
    return canManageGroup;
  });
  const activeTab = availableTabs.some((tab) => tab.id === requestedTab) ? requestedTab : availableTabs[0]?.id;
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    let nextIndex: number | undefined;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % availableTabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + availableTabs.length) % availableTabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = availableTabs.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTab = availableTabs[nextIndex];
    setRequestedTab(nextTab.id);
    tabRefs.current[nextTab.id]?.focus();
  };
  if (!activeTab) return <Page title={t('admin.title')}><StatePanel kind="error" title={t('admin.noAccessTitle')} message={t('admin.noAccessMessage')} /></Page>;
  return (
    <Page className={styles.page} title={t('admin.title')} wide>
      <div aria-label={t('admin.areas')} aria-orientation="horizontal" className={tabStyles.tabs} role="tablist">
        {availableTabs.map((tab, index) => {
          const selected = activeTab === tab.id;
          return <button aria-controls={`${tabGroupId}-panel-${tab.id}`} aria-selected={selected} className={selected ? tabStyles.activeTab : ''} id={`${tabGroupId}-tab-${tab.id}`} key={tab.id} onClick={() => setRequestedTab(tab.id)} onKeyDown={(event) => handleTabKeyDown(event, index)} ref={(element) => { tabRefs.current[tab.id] = element; }} role="tab" tabIndex={selected ? 0 : -1} type="button">{t(tab.labelKey)}</button>;
        })}
      </div>
      <section aria-labelledby={`${tabGroupId}-tab-${activeTab}`} className={styles.panel} id={`${tabGroupId}-panel-${activeTab}`} role="tabpanel" tabIndex={0}>
        {activeTab === 'system' ? <Suspense fallback={<StatePanel kind="loading" />}><SystemSettingsPanel /></Suspense> : null}
        {activeTab === 'settings' && activeGroup ? <BehaviorSettingsPanel key={activeGroup.id} /> : null}
        {activeTab === 'members' && activeGroup ? <MembersPanel key={activeGroup.id} /> : null}
        {activeTab === 'rights' && activeGroup ? <RightsPanel key={activeGroup.id} /> : null}
        {activeTab === 'audit' && activeGroup ? <AuditPanel key={activeGroup.id} /> : null}
        {activeTab === 'exports' && activeGroup ? <DataExportPanel groupId={activeGroup.id} intro={t('exports.data.groupIntro')} key={activeGroup.id} scope="GROUP" title={t('exports.data.groupTitle')} /> : null}
      </section>
    </Page>
  );
}
