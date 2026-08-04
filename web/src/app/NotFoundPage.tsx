import { Link } from '@tanstack/react-router';
import Compass from 'lucide-react/dist/esm/icons/compass';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import styles from './NotFoundPage.module.css';

/**
 * Renders a friendly route-level 404 state.
 *
 * @returns A localized not-found page with a dashboard link.
 */
export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <main className={styles.page}>
      <Compass aria-hidden="true" size={48} strokeWidth={1.5} />
      <h1>{t('notFound.title')}</h1>
      <p>{t('notFound.message')}</p>
      <Button><Link to="/">{t('notFound.back')}</Link></Button>
    </main>
  );
}
