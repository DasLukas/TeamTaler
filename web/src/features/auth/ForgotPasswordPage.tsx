import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, Navigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { AuthLayout } from './AuthLayout';
import styles from './AuthForms.module.css';
import { authenticationCapabilitiesQueryKey } from './authenticationCapabilities';

interface ForgotPasswordForm {
  email: string;
}

/**
 * Requests a password-reset message without revealing whether an account exists.
 *
 * @returns The capability-gated reset request page.
 */
export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const capabilities = useQuery({ queryKey: authenticationCapabilitiesQueryKey, queryFn: api.getAuthenticationCapabilities, retry: false, staleTime: Infinity });
  const { register, handleSubmit, formState: { errors } } = useForm<ForgotPasswordForm>();
  const mutation = useMutation({ mutationFn: ({ email }: ForgotPasswordForm) => api.requestPasswordReset(email) });

  if (!capabilities.isPending && capabilities.data?.passwordResetAvailable !== true) return <Navigate replace to="/login" />;

  return (
    <AuthLayout footer={<Link to="/login">{t('auth.backToLogin')}</Link>} intro={t('auth.forgotPasswordIntro')} title={t('auth.forgotPasswordTitle')}>
      {capabilities.isPending ? <p aria-live="polite" className={styles.status}>{t('common.loading')}</p> : mutation.isSuccess ? (
        <div aria-live="polite" className={styles.result}>
          <h2>{t('auth.resetRequestedTitle')}</h2>
          <p>{t('auth.resetRequestedMessage')}</p>
        </div>
      ) : (
        <form className={styles.form} onSubmit={handleSubmit((values) => mutation.mutate(values))}>
          <Field error={errors.email?.message} htmlFor="forgot-password-email" label={t('auth.email')}>
            <TextInput autoComplete="email" id="forgot-password-email" type="email" {...register('email', { required: t('auth.emailRequired') })} />
          </Field>
          {mutation.isError ? <p className={styles.error} role="alert">{t('auth.resetRequestError')}</p> : null}
          <Button disabled={mutation.isPending} fullWidth size="large" type="submit">{mutation.isPending ? t('auth.resetRequestPending') : t('auth.sendResetLink')}</Button>
        </form>
      )}
    </AuthLayout>
  );
}
