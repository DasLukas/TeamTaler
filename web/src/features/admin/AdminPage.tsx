import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hasGroupCapability } from '@/app/groupCapabilities';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { StatePanel } from '@/components/ui/StatePanel';
import { AuditPanel } from './AuditPanel';
import { GroupSettingsPanel } from './GroupSettingsPanel';
import { MembersPanel } from './MembersPanel';
import { RightsPanel } from './RightsPanel';
import styles from './AdminPage.module.css';

type AdminTab = 'group' | 'members' | 'rights' | 'audit';

const tabs: Array<{ id: AdminTab; labelKey: string }> = [
  { id: 'group', labelKey: 'admin.tabs.group' },
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
  const roles = activeGroup.membership?.roles ?? [];
  const canManageAdministration = hasGroupCapability(roles, 'administration');
  const [requestedTab, setRequestedTab] = useState<AdminTab>('group');
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const activeTab = requestedTab;
  const openMemberRights = (membershipId: string) => {
    setSelectedMemberId(membershipId);
    setRequestedTab('rights');
  };
  if (!canManageAdministration) return <Page title={t('admin.title')}><StatePanel kind="error" title={t('admin.noAccessTitle')} message={t('admin.noAccessMessage')} /></Page>;
  return (
    <Page className={styles.page} title={t('admin.title')} wide>
      <div aria-label={t('admin.areas')} className={styles.tabs} role="tablist">
        {tabs.map((tab) => <button aria-selected={activeTab === tab.id} className={activeTab === tab.id ? styles.activeTab : ''} key={tab.id} onClick={() => setRequestedTab(tab.id)} role="tab" type="button">{t(tab.labelKey)}</button>)}
      </div>
      <section aria-label={t(tabs.find((tab) => tab.id === activeTab)?.labelKey ?? 'admin.title')} className={styles.panel} role="tabpanel">
        {activeTab === 'group' ? <GroupSettingsPanel /> : null}
        {activeTab === 'members' ? <MembersPanel onOpenRights={openMemberRights} /> : null}
        {activeTab === 'rights' ? <RightsPanel onSelectedMemberChange={setSelectedMemberId} selectedMemberId={selectedMemberId || undefined} /> : null}
        {activeTab === 'audit' ? <AuditPanel /> : null}
      </section>
    </Page>
  );
}
