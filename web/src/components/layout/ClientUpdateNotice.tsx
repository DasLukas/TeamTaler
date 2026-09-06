import { useQuery } from '@tanstack/react-query';
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { clientBuildId } from '@/app/clientBuild';
import { Button } from '@/components/ui/Button';
import { FloatingNotice } from './FloatingNoticeRegion';
import styles from './ClientUpdateNotice.module.css';

const buildCheckIntervalMilliseconds = 5 * 60 * 1_000;

interface ClientUpdateNoticeProps {
  reload?: () => void;
}

function reloadClient(): void {
  window.location.reload();
}

/**
 * Announces a newer deployed web client and lets the user reload deliberately.
 *
 * @param props - Optional reload callback used by isolated interaction tests.
 * @returns A persistent update notice when server and client builds differ.
 */
export function ClientUpdateNotice({ reload = reloadClient }: ClientUpdateNoticeProps = {}) {
  const { t } = useTranslation();
  const buildQuery = useQuery({
    queryKey: ['instance-build'],
    queryFn: api.getBuildInformation,
    refetchInterval: buildCheckIntervalMilliseconds,
    refetchIntervalInBackground: false,
    refetchOnReconnect: true,
    refetchOnWindowFocus: 'always',
    retry: false,
    staleTime: 0,
  });

  if (!buildQuery.data || buildQuery.data.buildId === clientBuildId) return null;

  return (
    <FloatingNotice>
      <aside aria-live="polite" className={styles.notice} role="status">
        <p className={styles.message}>{t('clientUpdate.message')}</p>
        <Button className={styles.reload} leadingIcon={<RefreshCw size={16} />} onClick={reload} size="small">
          {t('clientUpdate.reload')}
        </Button>
      </aside>
    </FloatingNotice>
  );
}
