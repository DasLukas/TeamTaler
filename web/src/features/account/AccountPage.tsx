import { useTranslation } from 'react-i18next';
import { clientVersion } from '@/app/clientBuild';
import { useOptionalActiveGroup } from '@/app/useActiveGroup';
import { LegalLinks } from '@/components/legal/LegalLinks';
import { Page } from '@/components/layout/Page';
import { DataExportPanel } from '@/features/exports/DataExportPanel';
import styles from './AccountPage.module.css';
import { AccountDetailsPanel } from './AccountDetailsPanel';
import { AccountFinanceSection } from './AccountFinanceSection';
import { AppearanceSettingsPanel } from './AppearanceSettingsPanel';
import { NotificationPreferencesPanel } from './NotificationPreferencesPanel';
import { ProfileImagePanel } from './ProfileImagePanel';

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
      <footer className={styles.accountMeta}>
        <span>{t('account.appVersion', { version: clientVersion })}</span>
        <LegalLinks />
      </footer>
    </Page>
  );
}
