import { Link } from '@tanstack/react-router';
import BookOpenCheck from 'lucide-react/dist/esm/icons/book-open-check';
import Clock3 from 'lucide-react/dist/esm/icons/clock-3';
import Ellipsis from 'lucide-react/dist/esm/icons/ellipsis';
import Home from 'lucide-react/dist/esm/icons/home';
import { useTranslation } from 'react-i18next';
import { memberPaths } from '@/app/paths';
import styles from './BottomNavigation.module.css';

const items = [
  { to: memberPaths.overview, key: 'overview', icon: Home },
  { to: memberPaths.booking, key: 'book', icon: BookOpenCheck },
  { to: '/activities', key: 'activities', icon: Clock3 },
  { to: '/more', key: 'more', icon: Ellipsis },
] as const;

/**
 * Renders the fixed four-destination mobile primary navigation.
 *
 * @returns A localized navigation landmark.
 */
export function BottomNavigation() {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('nav.mobilePrimary')} className={styles.nav}>
      {items.map(({ to, key, icon: Icon }) => (
        <Link activeOptions={{ exact: true }} activeProps={{ className: styles.active }} className={styles.link} key={to} to={to}>
          <Icon aria-hidden="true" size={27} strokeWidth={1.8} />
          <span>{t(`nav.${key}`)}</span>
        </Link>
      ))}
    </nav>
  );
}
