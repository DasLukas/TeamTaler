import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { api, isDevelopmentDemoEnabled } from '@/api/client';
import type { LoginCommand } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { AuthLayout } from './AuthLayout';
import styles from './AuthForms.module.css';

/**
 * Renders and submits the local-account login form.
 *
 * @returns A localized authentication page.
 */
export function LoginPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { register, handleSubmit, formState: { errors } } = useForm<LoginCommand>({ defaultValues: isDevelopmentDemoEnabled ? { email: 'lukas@example.test', password: 'teamtaler-demo' } : { email: '', password: '' } });
  const loginMutation = useMutation({
    mutationFn: api.login,
    onSuccess: async (session) => {
      queryClient.setQueryData(['session'], session);
      await navigate({ to: '/' });
    },
  });

  return (
    <AuthLayout footer={<><Link to="/invite">{t('auth.inviteLink')}</Link> · <span>{t('auth.privacy')}</span></>} intro={t('auth.loginIntro')} title={t('auth.loginTitle')}>
      <form className={styles.form} onSubmit={handleSubmit((values) => loginMutation.mutate(values))}>
        <Field error={errors.email?.message} htmlFor="login-email" label={t('auth.email')}>
          <TextInput autoComplete="email" id="login-email" type="email" {...register('email', { required: t('auth.emailRequired') })} />
        </Field>
        <Field error={errors.password?.message} htmlFor="login-password" label={t('auth.password')}>
          <TextInput autoComplete="current-password" id="login-password" type="password" {...register('password', { required: t('auth.passwordRequired'), maxLength: { value: 1024, message: t('auth.passwordMax') } })} />
        </Field>
        {loginMutation.isError ? <p className={styles.error} role="alert">{loginMutation.error.message}</p> : null}
        <Button disabled={loginMutation.isPending} fullWidth size="large" type="submit">{loginMutation.isPending ? t('auth.loginPending') : t('auth.loginAction')}</Button>
      </form>
    </AuthLayout>
  );
}
