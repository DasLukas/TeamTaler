import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { AuthLayout } from './AuthLayout';
import styles from './AuthForms.module.css';
import { useFragmentToken } from './useFragmentToken';
import { clearAuthenticationState } from './clearAuthenticationState';

/**
 * Confirms an email-address change from a one-time fragment token.
 *
 * @returns A progress, success, or invalid-link screen.
 */
export function EmailChangeConfirmationPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const token = useFragmentToken('/email-change/confirm');
  const started = useRef(false);
  const mutation = useMutation({
    mutationFn: () => api.confirmEmailChange(token),
    onSuccess: async () => {
      clearAuthenticationState(queryClient);
      await navigate({ to: '/login', replace: true });
    },
  });
  const { mutate } = mutation;
  useEffect(() => {
    if (started.current || !token) return;
    started.current = true;
    mutate();
  }, [mutate, token]);

  return (
    <AuthLayout footer={<Link to="/login">{t('auth.backToLogin')}</Link>} intro={t('auth.emailConfirmationIntro')} title={t('auth.emailConfirmationTitle')}>
      <div aria-live="polite" className={styles.result}>
        {token && !mutation.isError && !mutation.isSuccess ? <p>{t('auth.emailConfirmationPending')}</p> : null}
        {mutation.isSuccess ? <><h2>{t('auth.emailChangedTitle')}</h2><p>{t('auth.emailChangedMessage')}</p><Link className={styles.primaryLink} to="/login">{t('auth.backToLogin')}</Link></> : null}
        {!token || mutation.isError ? <p className={styles.error} role="alert">{t('auth.invalidEmailChangeLink')}</p> : null}
      </div>
    </AuthLayout>
  );
}
