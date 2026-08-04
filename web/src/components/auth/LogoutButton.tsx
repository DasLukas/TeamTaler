import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right';
import LogOut from 'lucide-react/dist/esm/icons/log-out';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';

interface LogoutButtonProps {
  className?: string;
  showChevron?: boolean;
}

/**
 * Ends the server session, clears all cached private data, and opens login.
 *
 * @param props - Styling and optional trailing-chevron configuration.
 * @returns An accessible logout button.
 */
export function LogoutButton({ className = '', showChevron = false }: LogoutButtonProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const { t } = useTranslation();

  const logout = async () => {
    setPending(true);
    try {
      await api.logout();
    } finally {
      queryClient.clear();
      await navigate({ to: '/login' });
      setPending(false);
    }
  };

  return (
    <button className={className} disabled={pending} onClick={() => void logout()} type="button">
      <LogOut aria-hidden="true" size={23} strokeWidth={1.8} />
      <span>{pending ? t('logout.pending') : t('logout.action')}</span>
      {showChevron ? <ChevronRight aria-hidden="true" size={20} /> : null}
    </button>
  );
}
