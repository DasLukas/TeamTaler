import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import CircleCheck from 'lucide-react/dist/esm/icons/circle-check';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/api/client';
import { preferredAuthenticatedPath } from '@/app/groupCapabilities';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { AuthLayout } from './AuthLayout';
import styles from './AuthForms.module.css';

interface InvitationForm {
  displayName: string;
  password: string;
  passwordConfirmation: string;
}

const accountStateChangedProblem = 'https://teamtaler.dev/problems/invitation-account-state-changed';

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
  const [accountStateChanged, setAccountStateChanged] = useState(false);
  const { register, handleSubmit, getValues, reset, formState: { errors } } = useForm<InvitationForm>({ defaultValues: { displayName: '', password: '', passwordConfirmation: '' } });
  const previewQuery = useQuery({
    queryKey: ['invitation-preview', token],
    queryFn: () => api.previewInvitation(token),
    enabled: Boolean(token),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  useEffect(() => {
    if (!previewQuery.data) return;
    reset({ displayName: previewQuery.data.displayName, password: '', passwordConfirmation: '' });
  }, [previewQuery.data, reset]);
  const existingAccount = previewQuery.data?.accountState === 'EXISTING';
  const invitationMutation = useMutation({
    mutationFn: (form: InvitationForm) => api.acceptInvitation({
      token,
      displayName: form.displayName,
      password: form.password,
      expectedAccountState: existingAccount ? 'EXISTING' : 'NEW',
    }),
    onMutate: () => setAccountStateChanged(false),
    onError: async (error) => {
      if (!(error instanceof ApiError) || error.problem.type !== accountStateChangedProblem) return;
      setAccountStateChanged(true);
      await previewQuery.refetch();
    },
    onSuccess: async (session) => {
      queryClient.setQueryData(['session'], session);
      queryClient.removeQueries({ queryKey: ['invitation-preview', token] });
      window.history.replaceState(null, '', '/invite');
      await navigate({ to: preferredAuthenticatedPath(session) });
    },
  });

  return (
    <AuthLayout footer={<Link to="/login">{t('auth.backToLogin')}</Link>} intro={t('auth.inviteIntro')} title={t('auth.inviteTitle')}>
      {!token ? <p className={styles.warning} role="alert">{t('auth.invalidToken')}</p> : null}
      {previewQuery.isLoading ? <p>{t('auth.invitationLoading')}</p> : null}
      {previewQuery.isError ? <p className={styles.warning} role="alert">{t('auth.invitationInvalidOrExpired')}</p> : null}
      {previewQuery.data ? <form className={styles.form} onSubmit={handleSubmit((values) => invitationMutation.mutate(values))}>
        {existingAccount ? <label><input checked disabled readOnly type="checkbox" /> {t('auth.existingAccountDetected')}</label> : null}
        {accountStateChanged ? <p className={styles.warning} role="alert">{t('auth.invitationAccountStateChanged')}</p> : null}
        <Field error={errors.displayName?.message} hint={existingAccount ? t('auth.existingDisplayNameHint') : undefined} htmlFor="invite-name" label={t('auth.displayName')}>
          <TextInput autoComplete="name" id="invite-name" readOnly={existingAccount} {...register('displayName', { required: existingAccount ? false : t('auth.displayNameRequired') })} />
        </Field>
        <Field error={errors.password?.message} hint={existingAccount ? t('auth.existingPasswordHint') : t('auth.passwordHint')} htmlFor="invite-password" label={existingAccount ? t('auth.existingPasswordLabel') : t('auth.password')}>
          <TextInput autoComplete={existingAccount ? 'current-password' : 'new-password'} id="invite-password" type="password" {...register('password', { required: t('auth.newPasswordRequired'), minLength: { value: 12, message: t('auth.passwordMinTwelve') }, maxLength: { value: 1024, message: t('auth.passwordMax') } })} />
        </Field>
        {!existingAccount ? <Field error={errors.passwordConfirmation?.message} htmlFor="invite-password-confirmation" label={t('auth.passwordConfirmation')}>
          <TextInput autoComplete="new-password" id="invite-password-confirmation" type="password" {...register('passwordConfirmation', { validate: (value) => existingAccount || value === getValues('password') || t('auth.passwordMismatch') })} />
        </Field> : null}
        {invitationMutation.isError && !accountStateChanged ? <p className={styles.error} role="alert">{invitationMutation.error.message}</p> : null}
        <Button disabled={!token || !previewQuery.data || invitationMutation.isPending} fullWidth leadingIcon={<CircleCheck size={19} />} size="large" type="submit">{t('auth.acceptInvitation')}</Button>
      </form> : null}
    </AuthLayout>
  );
}
