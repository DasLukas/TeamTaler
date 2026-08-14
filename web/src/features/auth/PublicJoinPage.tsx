import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import CheckCircle2 from 'lucide-react/dist/esm/icons/check-circle-2';
import MailCheck from 'lucide-react/dist/esm/icons/mail-check';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { LoginCommand } from '@/api/types';
import { preferredMemberPath } from '@/app/groupCapabilities';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { AuthLayout } from './AuthLayout';
import formStyles from './AuthForms.module.css';
import { loginErrorMessage } from './loginError';
import styles from './PublicJoinPage.module.css';

interface RegistrationForm {
  email: string;
  displayName: string;
  password: string;
  passwordConfirmation: string;
}

type JoinMode = 'existing' | 'new';

/**
 * Renders reusable public-link onboarding for authenticated, existing, and new
 * TeamTaler accounts without exposing account-existence lookup results.
 *
 * @returns A localized, responsive public join workflow.
 */
export function PublicJoinPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
  const [mode, setMode] = useState<JoinMode>('existing');
  const [registrationEmail, setRegistrationEmail] = useState('');
  const [resendSent, setResendSent] = useState(false);
  const sessionQuery = useQuery({ queryKey: ['session'], queryFn: api.getSession, retry: false, staleTime: 30_000 });
  const previewQuery = useQuery({ queryKey: ['public-join-preview', token], queryFn: () => api.previewPublicJoinLink(token), enabled: Boolean(token), retry: false, staleTime: 30_000 });
  const loginForm = useForm<LoginCommand>({ defaultValues: { email: '', password: '' } });
  const registrationForm = useForm<RegistrationForm>({ defaultValues: { email: '', displayName: '', password: '', passwordConfirmation: '' } });

  const finishJoin = async (session: Awaited<ReturnType<typeof api.acceptPublicJoinLink>>) => {
    queryClient.setQueryData(['session'], session);
    window.history.replaceState(null, '', '/join');
    const group = session.groups.find((candidate) => candidate.id === session.activeGroupId) ?? session.groups[0];
    await navigate({ to: preferredMemberPath(group?.membership?.effectiveGrants) });
  };
  const acceptMutation = useMutation({ mutationFn: () => api.acceptPublicJoinLink(token), onSuccess: finishJoin });
  const loginMutation = useMutation({
    mutationFn: async (command: LoginCommand) => {
      await api.login(command);
      return api.acceptPublicJoinLink(token);
    },
    onSuccess: finishJoin,
  });
  const registrationMutation = useMutation({
	mutationFn: (input: RegistrationForm) => api.startPublicJoinRegistration({ email: input.email, displayName: input.displayName, password: input.password, joinToken: token }),
    onSuccess: (_result, input) => setRegistrationEmail(input.email),
  });
  const resendMutation = useMutation({
    mutationFn: () => api.resendPublicJoinVerification(token, registrationEmail),
    onSuccess: () => setResendSent(true),
  });

  const session = sessionQuery.isSuccess ? sessionQuery.data : undefined;
  const error = acceptMutation.error ?? loginMutation.error ?? registrationMutation.error ?? resendMutation.error;
  const intro = previewQuery.data ? t('publicJoin.pageIntro', { group: previewQuery.data.groupName }) : t('publicJoin.pageTitle');

  return (
    <AuthLayout intro={intro} title={t('publicJoin.pageTitle')}>
      {!token || previewQuery.isError ? <div className={formStyles.warning} role="alert"><strong>{t('publicJoin.invalidTitle')}</strong><br />{t('publicJoin.invalidDescription')}</div> : null}
      {previewQuery.isLoading ? <p>{t('common.loading')}</p> : null}
      {previewQuery.data ? (
        <div className={styles.content}>
          {previewQuery.data.expiresAt ? <p className={styles.expiry}>{t('publicJoin.expires', { date: new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(previewQuery.data.expiresAt)) })}</p> : null}
          {session ? (
            <section className={styles.accountCard}>
              <CheckCircle2 aria-hidden="true" size={28} />
              <div><strong>{session.user.displayName}</strong><span>{t('publicJoin.signedInAs', { email: session.user.email })}</span></div>
              <Button disabled={acceptMutation.isPending} onClick={() => acceptMutation.mutate()}>{t('publicJoin.joinCurrentAccount')}</Button>
            </section>
          ) : registrationEmail ? (
            <section className={styles.checkEmail} role="status">
              <MailCheck aria-hidden="true" size={42} />
              <h2>{t('publicJoin.checkEmailTitle')}</h2>
              <p>{t('publicJoin.checkEmailDescription')}</p>
              <Button disabled={resendMutation.isPending} onClick={() => resendMutation.mutate()} variant="secondary">{t('publicJoin.resend')}</Button>
              {resendSent ? <small>{t('publicJoin.resendSent')}</small> : null}
            </section>
          ) : (
            <>
              <div aria-label={t('publicJoin.pageTitle')} className={styles.modeTabs} role="tablist">
                <button aria-selected={mode === 'existing'} className={mode === 'existing' ? styles.activeMode : ''} onClick={() => setMode('existing')} role="tab" type="button">{t('publicJoin.existingAccount')}</button>
                <button aria-selected={mode === 'new'} className={mode === 'new' ? styles.activeMode : ''} onClick={() => setMode('new')} role="tab" type="button">{t('publicJoin.newAccount')}</button>
              </div>
              {mode === 'existing' ? (
                <form className={formStyles.form} onSubmit={loginForm.handleSubmit((values) => loginMutation.mutate(values))}>
                  <p className={styles.hint}>{t('publicJoin.loginHint')}</p>
                  <Field error={loginForm.formState.errors.email?.message} htmlFor="join-login-email" label={t('auth.email')}><TextInput autoComplete="email" id="join-login-email" type="email" {...loginForm.register('email', { required: t('auth.emailRequired') })} /></Field>
                  <Field error={loginForm.formState.errors.password?.message} htmlFor="join-login-password" label={t('auth.password')}><TextInput autoComplete="current-password" id="join-login-password" type="password" {...loginForm.register('password', { required: t('auth.passwordRequired'), maxLength: { value: 1024, message: t('auth.passwordMax') } })} /></Field>
                  <Button disabled={loginMutation.isPending} fullWidth size="large" type="submit">{t('auth.loginAction')}</Button>
                </form>
              ) : (
                <form className={formStyles.form} onSubmit={registrationForm.handleSubmit((values) => registrationMutation.mutate(values))}>
                  <p className={styles.hint}>{t('publicJoin.registerHint')}</p>
                  <Field error={registrationForm.formState.errors.email?.message} htmlFor="join-register-email" label={t('auth.email')}><TextInput autoComplete="email" id="join-register-email" type="email" {...registrationForm.register('email', { required: t('auth.emailRequired') })} /></Field>
                  <Field error={registrationForm.formState.errors.displayName?.message} htmlFor="join-register-name" label={t('auth.displayName')}><TextInput autoComplete="name" id="join-register-name" maxLength={120} {...registrationForm.register('displayName', { required: t('auth.displayNameRequired') })} /></Field>
                  <Field error={registrationForm.formState.errors.password?.message} hint={t('auth.passwordHint')} htmlFor="join-register-password" label={t('auth.password')}><TextInput autoComplete="new-password" id="join-register-password" type="password" {...registrationForm.register('password', { required: t('auth.newPasswordRequired'), minLength: { value: 12, message: t('auth.passwordMinTwelve') }, maxLength: { value: 1024, message: t('auth.passwordMax') } })} /></Field>
                  <Field error={registrationForm.formState.errors.passwordConfirmation?.message} htmlFor="join-register-confirmation" label={t('auth.passwordConfirmation')}><TextInput autoComplete="new-password" id="join-register-confirmation" type="password" {...registrationForm.register('passwordConfirmation', { validate: (value) => value === registrationForm.getValues('password') || t('auth.passwordMismatch') })} /></Field>
                  <Button disabled={registrationMutation.isPending} fullWidth size="large" type="submit">{t('publicJoin.register')}</Button>
                </form>
              )}
            </>
          )}
          {error ? <p className={formStyles.error} role="alert">{loginMutation.isError ? loginErrorMessage(loginMutation.error, t) : error.message}</p> : null}
        </div>
      ) : null}
    </AuthLayout>
  );
}
