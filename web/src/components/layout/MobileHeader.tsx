import { useTranslation } from 'react-i18next';
import { useActiveGroup } from '@/app/useActiveGroup';
import { useInstanceCapabilities } from '@/app/useSession';
import { Brand } from '@/components/brand/Brand';
import { GroupSelector } from './GroupSelector';
import styles from './MobileHeader.module.css';

/**
 * Renders the compact mobile header with an active-group selector.
 *
 * @returns A localized header bound to the active group context.
 */
export function MobileHeader() {
  const { t } = useTranslation();
  const { session, activeGroupId, setActiveGroupId } = useActiveGroup();
  const instanceCapabilities = useInstanceCapabilities();
  return (
    <header className={styles.header}>
      <Brand name={instanceCapabilities.instanceName} />
      <GroupSelector ariaLabel={t('nav.selectGroup')} className={styles.group} groups={session.groups} id="mobile-group" onChange={setActiveGroupId} responsiveCompact value={activeGroupId} />
    </header>
  );
}
