import { useTranslation } from 'react-i18next';
import { hasGroupCapability } from '@/app/groupCapabilities';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Page } from '@/components/layout/Page';
import { StatePanel } from '@/components/ui/StatePanel';
import { CatalogPanel } from './CatalogPanel';

/**
 * Renders the catalog-manager workspace behind a query-safe role guard.
 *
 * @returns The catalog editor for authorized memberships or a neutral no-access state.
 */
export function CatalogPage() {
  const { t } = useTranslation();
  const { activeGroup } = useActiveGroup();
  const roles = activeGroup.membership?.roles ?? [];

  if (!hasGroupCapability(roles, 'catalog')) {
    return <Page title={t('catalog.title')}><StatePanel kind="error" title={t('catalog.noAccessTitle')} message={t('catalog.noAccessMessage')} /></Page>;
  }

  return <Page title={t('catalog.title')} wide><CatalogPanel /></Page>;
}
