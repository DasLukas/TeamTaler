import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down';
import UsersRound from 'lucide-react/dist/esm/icons/users-round';
import { useTranslation } from 'react-i18next';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Brand } from '@/components/brand/Brand';
import styles from './MobileHeader.module.css';

/**
 * Renders the compact mobile header with an active-group selector.
 *
 * @returns A localized header bound to the active group context.
 */
export function MobileHeader() {
  const { t } = useTranslation();
  const { session, activeGroupId, setActiveGroupId } = useActiveGroup();
  return (
    <header className={styles.header}>
      <Brand />
      <div className={styles.group}>
        <UsersRound aria-hidden="true" size={23} strokeWidth={1.8} />
        <select aria-label={t('nav.selectGroup')} onChange={(event) => setActiveGroupId(event.target.value)} value={activeGroupId}>
          {session.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
        <ChevronDown aria-hidden="true" size={18} />
      </div>
    </header>
  );
}
