import { useTranslation } from 'react-i18next';
import { Page } from '@/components/layout/Page';
import { useOptionalActiveGroup } from '@/app/useActiveGroup';
import { AccountDetailsPanel } from './AccountDetailsPanel';
import { AccountFinanceSection } from './AccountFinanceSection';
import { ProfileImagePanel } from './ProfileImagePanel';
import { NotificationPreferencesPanel } from './NotificationPreferencesPanel';

/**
 * Renders independent account settings, profile image, and financial sections.
 *
 * @returns The authenticated user's account workspace.
 */
export function AccountPage() {
  const { t } = useTranslation();
  const hasActiveGroup = useOptionalActiveGroup() !== null;
  return (
    <Page intro={t(hasActiveGroup ? 'account.intro' : 'account.systemOnlyIntro')} title={t('account.title')} wide>
      <AccountDetailsPanel />
      <ProfileImagePanel />
      <NotificationPreferencesPanel />
      {hasActiveGroup ? <AccountFinanceSection /> : null}
    </Page>
  );
}
