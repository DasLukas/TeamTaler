import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { AuthLayout } from './AuthLayout';
import styles from './AuthForms.module.css';

interface InvitationForm {
  displayName: string;
  password: string;
  passwordConfirmation: string;
  existingAccount: boolean;
}

/**
 * Renders invitation acceptance using a one-time URL-fragment token.
 *
 * @returns A localized account-creation form.
 */
export function InvitationPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
  const { register, handleSubmit, getValues, control, reset, formState: { errors } } = useForm<InvitationForm>({ defaultValues: { displayName: '', password: '', passwordConfirmation: '', existingAccount: false } });
  const existingAccount = useWatch({ control, name: 'existingAccount' });
  const previewQuery = useQuery({
    queryKey: ['invitation-preview'],
    queryFn: () => api.previewInvitation(token),
    enabled: Boolean(token),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  useEffect(() => {
    if (!previewQuery.data) return;
    reset({ displayName: previewQuery.data.displayName, password: '', passwordConfirmation: '', existingAccount: previewQuery.data.existingAccount });
  }, [previewQuery.data, reset]);
  const invitationMutation = useMutation({
    mutationFn: (form: InvitationForm) => api.acceptInvitation({ token, displayName: form.displayName, password: form.password }),
    onSuccess: async (session) => {
      queryClient.setQueryData(['session'], session);
      queryClient.removeQueries({ queryKey: ['invitation-preview'] });
      window.history.replaceState(null, '', '/invite');
      await navigate({ to: '/' });
    },
  });

  return (
    <AuthLayout footer={<Link to="/login">{t('auth.backToLogin')}</Link>} intro={t('auth.inviteIntro')} title={t('auth.inviteTitle')}>
      {!token ? <p className={styles.warning} role="alert">{t('auth.invalidToken')}</p> : null}
      {previewQuery.isLoading ? <p>{t('auth.invitationLoading')}</p> : null}
      {previewQuery.isError ? <p className={styles.warning} role="alert">{t('auth.invitationInvalidOrExpired')}</p> : null}
      {previewQuery.data ? <form className={styles.form} onSubmit={handleSubmit((values) => invitationMutation.mutate(values))}>
        {previewQuery.data?.existingAccount ? <label><input disabled type="checkbox" {...register('existingAccount')} /> {t('auth.existingAccountDetected')}</label> : null}
        <Field error={errors.displayName?.message} hint={existingAccount ? t('auth.existingDisplayNameHint') : undefined} htmlFor="invite-name" label={t('auth.displayName')}>
          <TextInput autoComplete="name" id="invite-name" readOnly={existingAccount} {...register('displayName', { required: existingAccount ? false : t('auth.displayNameRequired') })} />
        </Field>
        <Field error={errors.password?.message} hint={existingAccount ? t('auth.existingPasswordHint') : t('auth.passwordHint')} htmlFor="invite-password" label={existingAccount ? t('auth.existingPasswordLabel') : t('auth.password')}>
          <TextInput autoComplete={existingAccount ? 'current-password' : 'new-password'} id="invite-password" type="password" {...register('password', { required: t('auth.newPasswordRequired'), minLength: { value: 12, message: t('auth.passwordMinTwelve') }, maxLength: { value: 1024, message: t('auth.passwordMax') } })} />
        </Field>
        {!existingAccount ? <Field error={errors.passwordConfirmation?.message} htmlFor="invite-password-confirmation" label={t('auth.passwordConfirmation')}>
          <TextInput autoComplete="new-password" id="invite-password-confirmation" type="password" {...register('passwordConfirmation', { validate: (value) => existingAccount || value === getValues('password') || t('auth.passwordMismatch') })} />
        </Field> : null}
        {invitationMutation.isError ? <p className={styles.error} role="alert">{invitationMutation.error.message}</p> : null}
        <Button disabled={!token || !previewQuery.data || invitationMutation.isPending} fullWidth size="large" type="submit">{t('auth.acceptInvitation')}</Button>
      </form> : null}
    </AuthLayout>
  );
}
