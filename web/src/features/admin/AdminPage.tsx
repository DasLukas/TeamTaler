import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { can } from '@/app/permissions';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { StatePanel } from '@/components/ui/StatePanel';
import { AuditPanel } from './AuditPanel';
import { GroupSettingsPanel } from './GroupSettingsPanel';
import { BehaviorSettingsPanel } from './BehaviorSettingsPanel';
import { MembersPanel } from './MembersPanel';
import { RightsPanel } from './RightsPanel';
import styles from './AdminPage.module.css';

type AdminTab = 'group' | 'settings' | 'members' | 'rights' | 'audit';

const tabs: Array<{ id: AdminTab; labelKey: string }> = [
  { id: 'group', labelKey: 'admin.tabs.group' },
  { id: 'settings', labelKey: 'admin.tabs.settings' },
  { id: 'members', labelKey: 'admin.tabs.members' },
  { id: 'rights', labelKey: 'admin.tabs.rights' },
  { id: 'audit', labelKey: 'admin.tabs.audit' },
];

/**
 * Renders the role-aware administrative workspace.
 *
 * @returns Membership, permission, group, or audit tools.
 */
export function AdminPage() {
  const { t } = useTranslation();
  const { activeGroup } = useActiveGroup();
  const grants = activeGroup.membership?.effectiveGrants;
  const canManageGroup = can(grants, 'GROUP_ADMINISTRATION');
  const canManageRoles = can(grants, 'ROLE_MANAGEMENT');
  const canViewMemberDirectory = can(grants, 'VIEW_MEMBER_DIRECTORY');
  const tabGroupId = useId();
  const tabRefs = useRef<Partial<Record<AdminTab, HTMLButtonElement | null>>>({});
  const [requestedTab, setRequestedTab] = useState<AdminTab>('group');
  const availableTabs = tabs.filter((tab) => {
    if (tab.id === 'rights') return canManageRoles;
    if (tab.id === 'members') return canViewMemberDirectory && (canManageGroup || canManageRoles);
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
      <div aria-label={t('admin.areas')} aria-orientation="horizontal" className={styles.tabs} role="tablist">
        {availableTabs.map((tab, index) => {
          const selected = activeTab === tab.id;
          return <button aria-controls={`${tabGroupId}-panel-${tab.id}`} aria-selected={selected} className={selected ? styles.activeTab : ''} id={`${tabGroupId}-tab-${tab.id}`} key={tab.id} onClick={() => setRequestedTab(tab.id)} onKeyDown={(event) => handleTabKeyDown(event, index)} ref={(element) => { tabRefs.current[tab.id] = element; }} role="tab" tabIndex={selected ? 0 : -1} type="button">{t(tab.labelKey)}</button>;
        })}
      </div>
      <section aria-labelledby={`${tabGroupId}-tab-${activeTab}`} className={styles.panel} id={`${tabGroupId}-panel-${activeTab}`} role="tabpanel" tabIndex={0}>
        {activeTab === 'group' ? <GroupSettingsPanel key={activeGroup.id} /> : null}
        {activeTab === 'settings' ? <BehaviorSettingsPanel key={activeGroup.id} /> : null}
        {activeTab === 'members' ? <MembersPanel key={activeGroup.id} /> : null}
        {activeTab === 'rights' ? <RightsPanel key={activeGroup.id} /> : null}
        {activeTab === 'audit' ? <AuditPanel key={activeGroup.id} /> : null}
      </section>
    </Page>
  );
}
