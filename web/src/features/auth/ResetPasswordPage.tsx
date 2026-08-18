import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import KeyRound from 'lucide-react/dist/esm/icons/key-round';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/FormField';
import { AuthLayout } from './AuthLayout';
import styles from './AuthForms.module.css';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './passwordPolicy';
import { useFragmentToken } from './useFragmentToken';
import { clearAuthenticationState } from './clearAuthenticationState';

interface ResetPasswordForm {
  newPassword: string;
  passwordConfirmation: string;
}

/**
 * Replaces an account password using a one-time fragment token.
 *
 * @returns A password form or a safe invalid-link state.
 */
export function ResetPasswordPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const token = useFragmentToken('/reset-password');
  const { register, handleSubmit, formState: { errors } } = useForm<ResetPasswordForm>();
  const mutation = useMutation({
    mutationFn: ({ newPassword: password }: ResetPasswordForm) => api.confirmPasswordReset(token, password),
    onSuccess: async () => {
      clearAuthenticationState(queryClient);
      await navigate({ to: '/login', replace: true });
    },
  });

  return (
    <AuthLayout footer={<Link to="/login">{t('auth.backToLogin')}</Link>} intro={t('auth.resetPasswordIntro')} title={t('auth.resetPasswordTitle')}>
      {!token ? <p className={styles.error} role="alert">{t('auth.invalidResetLink')}</p> : mutation.isSuccess ? (
        <div aria-live="polite" className={styles.result}>
          <h2>{t('auth.passwordChangedTitle')}</h2>
          <p>{t('auth.passwordChangedMessage')}</p>
          <Link className={styles.primaryLink} to="/login">{t('auth.backToLogin')}</Link>
        </div>
      ) : (
        <form className={styles.form} onSubmit={handleSubmit((values) => mutation.mutate(values))}>
          <Field error={errors.newPassword?.message} hint={t('auth.passwordHint')} htmlFor="reset-password-new" label={t('auth.newPassword')}>
            <TextInput autoComplete="new-password" id="reset-password-new" type="password" {...register('newPassword', { required: t('auth.newPasswordRequired'), minLength: { value: PASSWORD_MIN_LENGTH, message: t('auth.passwordMinTwelve') }, maxLength: { value: PASSWORD_MAX_LENGTH, message: t('auth.passwordMax') } })} />
          </Field>
          <Field error={errors.passwordConfirmation?.message} htmlFor="reset-password-confirmation" label={t('auth.passwordConfirmation')}>
            <TextInput autoComplete="new-password" id="reset-password-confirmation" type="password" {...register('passwordConfirmation', { required: t('auth.passwordConfirmationRequired'), validate: (value, values) => value === values.newPassword || t('auth.passwordMismatch') })} />
          </Field>
          {mutation.isError ? <p className={styles.error} role="alert">{t('auth.invalidResetLink')}</p> : null}
          <Button disabled={mutation.isPending} fullWidth leadingIcon={<KeyRound size={19} />} size="large" type="submit">{mutation.isPending ? t('auth.passwordSavePending') : t('auth.savePassword')}</Button>
        </form>
      )}
    </AuthLayout>
  );
}
