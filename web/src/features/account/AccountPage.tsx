import { useTranslation } from 'react-i18next';
import { Page } from '@/components/layout/Page';
import { AccountDetailsPanel } from './AccountDetailsPanel';
import { AccountFinanceSection } from './AccountFinanceSection';
import { ProfileImagePanel } from './ProfileImagePanel';

/**
 * Renders independent account settings, profile image, and financial sections.
 *
 * @returns The authenticated user's account workspace.
 */
export function AccountPage() {
  const { t } = useTranslation();
  return (
    <Page intro={t('account.intro')} title={t('account.title')} wide>
      <AccountDetailsPanel />
      <ProfileImagePanel />
      <AccountFinanceSection />
    </Page>
  );
}
