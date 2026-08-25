import { useTranslation } from 'react-i18next';
import { Page } from '@/components/layout/Page';
import { useOptionalActiveGroup } from '@/app/useActiveGroup';
import { AccountDetailsPanel } from './AccountDetailsPanel';
import { AccountFinanceSection } from './AccountFinanceSection';
import { ProfileImagePanel } from './ProfileImagePanel';
import { NotificationPreferencesPanel } from './NotificationPreferencesPanel';
import { AppearanceSettingsPanel } from './AppearanceSettingsPanel';
import { DataExportPanel } from '@/features/exports/DataExportPanel';

/**
 * Renders independent account settings, profile image, and financial sections.
 *
 * @returns The authenticated user's account workspace.
 */
export function AccountPage() {
  const { t } = useTranslation();
  const groupContext = useOptionalActiveGroup();
  const hasActiveGroup = groupContext !== null;
  return (
    <Page intro={t(hasActiveGroup ? 'account.intro' : 'account.systemOnlyIntro')} title={t('account.title')} wide>
      <AccountDetailsPanel />
      <AppearanceSettingsPanel />
      <ProfileImagePanel />
      <NotificationPreferencesPanel />
      {groupContext ? <DataExportPanel groupId={groupContext.activeGroupId} intro={t('exports.data.personalIntro')} scope="PERSONAL" title={t('exports.data.personalTitle')} /> : null}
      {hasActiveGroup ? <AccountFinanceSection /> : null}
    </Page>
  );
}
