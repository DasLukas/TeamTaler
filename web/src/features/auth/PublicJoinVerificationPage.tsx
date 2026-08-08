import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import CheckCircle2 from 'lucide-react/dist/esm/icons/check-circle-2';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { preferredMemberPath } from '@/app/groupCapabilities';
import { AuthLayout } from './AuthLayout';
import formStyles from './AuthForms.module.css';
import styles from './PublicJoinPage.module.css';

/**
 * Consumes a one-time public-registration verification token and establishes
 * the resulting authenticated TeamTaler session.
 *
 * @returns A focused progress, success, or invalid-token screen.
 */
export function PublicJoinVerificationPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const started = useRef(false);
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
  const mutation = useMutation({
    mutationFn: () => api.confirmPublicJoinRegistration(token),
    onSuccess: async (session) => {
      queryClient.setQueryData(['session'], session);
      window.history.replaceState(null, '', '/join/verify');
      const group = session.groups.find((candidate) => candidate.id === session.activeGroupId) ?? session.groups[0];
      await navigate({ to: preferredMemberPath(group?.membership?.effectiveGrants) });
    },
  });
  useEffect(() => {
    if (started.current || !token) return;
    started.current = true;
    mutation.mutate();
  }, [mutation, token]);
  return (
    <AuthLayout intro={t('publicJoin.verificationPending')} title={t('publicJoin.verificationTitle')}>
      <div aria-live="polite" className={styles.verificationState}>
        {mutation.isPending ? <p>{t('publicJoin.verificationPending')}</p> : null}
        {mutation.isSuccess ? <><CheckCircle2 aria-hidden="true" size={42} /><p>{t('publicJoin.verificationSuccess')}</p></> : null}
        {!token || mutation.isError ? <p className={formStyles.error} role="alert">{t('publicJoin.verificationError')}</p> : null}
      </div>
    </AuthLayout>
  );
}
