import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '@/api/client';
import type { Membership, Session, User } from '@/api/types';
import { useSession } from '@/app/useSession';
import { Button } from '@/components/ui/Button';
import { Field, SelectInput, TextInput } from '@/components/ui/FormField';
import { Modal } from '@/components/ui/Modal';
import { authenticationCapabilitiesQueryKey } from '@/features/auth/authenticationCapabilities';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/features/auth/passwordPolicy';
import { clearAuthenticationState } from '@/features/auth/clearAuthenticationState';
import styles from './AccountDetailsPanel.module.css';

type AccountDialog = 'name' | 'password' | 'email';

interface NameForm { displayName: string }
interface PasswordForm { currentPassword: string; newPassword: string; passwordConfirmation: string }
interface EmailForm { newEmail: string; currentPassword: string }

const LAST_USED_GROUP_VALUE = '__LAST_USED_GROUP__';

function accountMutationError(error: unknown, kind: AccountDialog, t: (key: string) => string): string {
  if (error instanceof ApiError) {
    if (error.problem.status === 401) return t('account.details.currentPasswordInvalid');
    if (kind === 'email' && error.problem.status === 409) return t('account.details.emailUnavailable');
    if (error.problem.status === 429) return t('account.details.tryAgainLater');
    if (error.problem.status === 503) return t('account.details.featureUnavailable');
  }
  return t('account.details.saveError');
}

function updateUserProjections(queryClient: ReturnType<typeof useQueryClient>, user: User): void {
  queryClient.setQueryData<Session>(['session'], (current) => current ? { ...current, user } : current);
  queryClient.setQueriesData<Membership[]>({ queryKey: ['members'] }, (members) => members?.map((member) => (
    member.userId === user.id ? { ...member, displayName: user.displayName, email: user.email, avatarUrl: user.avatarUrl } : member
  )));
}

function NameChangeForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const session = useSession();
  const queryClient = useQueryClient();
  const { register, handleSubmit, formState: { errors } } = useForm<NameForm>({ defaultValues: { displayName: session.user.displayName } });
  const mutation = useMutation({
    mutationFn: ({ displayName }: NameForm) => api.updateProfile(displayName.trim()),
    onSuccess: async (user) => {
      updateUserProjections(queryClient, user);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['members'] }),
        queryClient.invalidateQueries({ queryKey: ['booking-context'] }),
        queryClient.invalidateQueries({ queryKey: ['bookings'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['account-summaries'] }),
      ]);
      onSaved();
    },
  });
  return (
    <form className={styles.form} onSubmit={handleSubmit((values) => mutation.mutate(values))}>
      <Field error={errors.displayName?.message} hint={t('account.details.nameScope')} htmlFor="account-display-name" label={t('account.details.name')}>
        <TextInput autoComplete="name" id="account-display-name" {...register('displayName', { validate: {
          present: (value) => value.trim().length > 0 || t('auth.displayNameRequired'),
          length: (value) => Array.from(value.trim()).length <= 120 || t('account.details.nameTooLong'),
          controls: (value) => !/[\p{Cc}\p{Cf}]/u.test(value) || t('account.details.nameInvalid'),
        } })} />
      </Field>
      {mutation.isError ? <p className={styles.error} role="alert">{accountMutationError(mutation.error, 'name', t)}</p> : null}
      <div className={styles.dialogActions}><Button onClick={onClose} variant="secondary">{t('common.cancel')}</Button><Button disabled={mutation.isPending} type="submit">{mutation.isPending ? t('common.saving') : t('common.save')}</Button></div>
    </form>
  );
}

function PasswordChangeForm() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { register, handleSubmit, formState: { errors } } = useForm<PasswordForm>();
  const mutation = useMutation({
    mutationFn: ({ currentPassword, newPassword: password }: PasswordForm) => api.changePassword(currentPassword, password),
    onSuccess: async () => {
      clearAuthenticationState(queryClient);
      await navigate({ to: '/login', replace: true });
    },
  });
  return (
    <form className={styles.form} onSubmit={handleSubmit((values) => mutation.mutate(values))}>
      <Field error={errors.currentPassword?.message} htmlFor="account-current-password" label={t('account.details.currentPassword')}>
        <TextInput autoComplete="current-password" id="account-current-password" type="password" {...register('currentPassword', { required: t('auth.passwordRequired'), maxLength: { value: PASSWORD_MAX_LENGTH, message: t('auth.passwordMax') } })} />
      </Field>
      <Field error={errors.newPassword?.message} hint={t('auth.passwordHint')} htmlFor="account-new-password" label={t('auth.newPassword')}>
        <TextInput autoComplete="new-password" id="account-new-password" type="password" {...register('newPassword', { required: t('auth.newPasswordRequired'), minLength: { value: PASSWORD_MIN_LENGTH, message: t('auth.passwordMinTwelve') }, maxLength: { value: PASSWORD_MAX_LENGTH, message: t('auth.passwordMax') }, validate: (value, values) => value !== values.currentPassword || t('account.details.passwordMustDiffer') })} />
      </Field>
      <Field error={errors.passwordConfirmation?.message} htmlFor="account-password-confirmation" label={t('auth.passwordConfirmation')}>
        <TextInput autoComplete="new-password" id="account-password-confirmation" type="password" {...register('passwordConfirmation', { required: t('auth.passwordConfirmationRequired'), validate: (value, values) => value === values.newPassword || t('auth.passwordMismatch') })} />
      </Field>
      {mutation.isError ? <p className={styles.error} role="alert">{accountMutationError(mutation.error, 'password', t)}</p> : null}
      <Button disabled={mutation.isPending} fullWidth type="submit">{mutation.isPending ? t('auth.passwordSavePending') : t('auth.savePassword')}</Button>
    </form>
  );
}

function EmailChangeForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { register, handleSubmit, formState: { errors } } = useForm<EmailForm>();
  const mutation = useMutation({ mutationFn: ({ newEmail, currentPassword }: EmailForm) => api.requestEmailChange(newEmail, currentPassword) });
  if (mutation.isSuccess) return (
    <div aria-live="polite" className={styles.result}>
      <h3>{t('account.details.emailRequestedTitle')}</h3>
      <p>{t('account.details.emailRequestedMessage')}</p>
      <Button onClick={onClose}>{t('common.done')}</Button>
    </div>
  );
  return (
    <form className={styles.form} onSubmit={handleSubmit((values) => mutation.mutate(values))}>
      <Field error={errors.newEmail?.message} htmlFor="account-new-email" label={t('account.details.newEmail')}>
        <TextInput autoComplete="email" id="account-new-email" maxLength={254} type="email" {...register('newEmail', { required: t('auth.emailRequired'), maxLength: { value: 254, message: t('account.details.emailTooLong') } })} />
      </Field>
      <Field error={errors.currentPassword?.message} htmlFor="account-email-current-password" label={t('account.details.currentPassword')}>
        <TextInput autoComplete="current-password" id="account-email-current-password" type="password" {...register('currentPassword', { required: t('auth.passwordRequired'), maxLength: { value: PASSWORD_MAX_LENGTH, message: t('auth.passwordMax') } })} />
      </Field>
      {mutation.isError ? <p className={styles.error} role="alert">{accountMutationError(mutation.error, 'email', t)}</p> : null}
      <div className={styles.dialogActions}><Button onClick={onClose} variant="secondary">{t('common.cancel')}</Button><Button disabled={mutation.isPending} type="submit">{mutation.isPending ? t('account.details.emailRequestPending') : t('account.details.emailRequest')}</Button></div>
    </form>
  );
}

function DefaultGroupSetting({ session }: { session: Session }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const persistedValue = session.defaultGroupId ?? LAST_USED_GROUP_VALUE;
  const [selection, setSelection] = useState(persistedValue);
  const mutation = useMutation({
    mutationFn: () => api.updateDefaultGroup(selection === LAST_USED_GROUP_VALUE ? null : selection),
    onSuccess: (preference) => {
      queryClient.setQueryData<Session>(['session'], (current) => current ? { ...current, defaultGroupId: preference.defaultGroupId } : current);
    },
  });
  return (
    <div className={styles.preferenceRow}>
      <dt>{t('account.details.defaultGroup')}</dt>
      <dd className={styles.preference}>
        <SelectInput
          aria-label={t('account.details.defaultGroup')}
          id="account-default-group"
          onChange={(event) => { setSelection(event.target.value); mutation.reset(); }}
          value={selection}
        >
          <option value={LAST_USED_GROUP_VALUE}>{t('account.details.lastUsedGroup')}</option>
          {session.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </SelectInput>
        <span className={styles.preferenceHint}>{t('account.details.defaultGroupHint')}</span>
        {mutation.isSuccess ? <span className={styles.success} role="status">{t('account.details.defaultGroupSaved')}</span> : null}
        {mutation.isError ? <span className={styles.error} role="alert">{t('account.details.saveError')}</span> : null}
      </dd>
      <Button disabled={selection === persistedValue || mutation.isPending} onClick={() => mutation.mutate()} size="small" variant="secondary">
        {mutation.isPending ? t('common.saving') : t('common.save')}
      </Button>
    </div>
  );
}

/**
 * Renders self-service account data with responsive change dialogs.
 *
 * @returns Name, email, password, and multi-group login-preference controls available for this deployment.
 */
export function AccountDetailsPanel() {
  const { t } = useTranslation();
  const session = useSession();
  const [dialog, setDialog] = useState<AccountDialog>();
  const [successMessage, setSuccessMessage] = useState('');
  const capabilities = useQuery({ queryKey: authenticationCapabilitiesQueryKey, queryFn: api.getAuthenticationCapabilities, retry: false, staleTime: Infinity });
  const closeDialog = () => setDialog(undefined);
  const dialogTitles: Record<AccountDialog, string> = {
    name: t('account.details.nameChangeTitle'),
    password: t('account.details.passwordChangeTitle'),
    email: t('account.details.emailChangeTitle'),
  };
  return (
    <section aria-labelledby="account-details-title" className={styles.card}>
      <h2 id="account-details-title">{t('account.details.title')}</h2>
      <dl className={styles.list}>
        <div><dt>{t('account.details.name')}</dt><dd>{session.user.displayName}</dd><Button onClick={() => setDialog('name')} size="small" variant="secondary">{t('common.edit')}</Button></div>
        <div><dt>{t('account.details.email')}</dt><dd>{session.user.email}</dd>{capabilities.data?.emailChangeAvailable === true ? <Button onClick={() => setDialog('email')} size="small" variant="secondary">{t('common.edit')}</Button> : null}</div>
        <div><dt>{t('account.details.password')}</dt><dd aria-label={t('account.details.password')}>••••••••••••</dd><Button onClick={() => setDialog('password')} size="small" variant="secondary">{t('common.edit')}</Button></div>
        {session.groups.length > 1 ? <DefaultGroupSetting session={session} /> : null}
      </dl>
      {successMessage ? <p className={styles.success} role="status">{successMessage}</p> : null}
      <Modal onClose={closeDialog} open={dialog !== undefined} title={dialog ? dialogTitles[dialog] : ''} variant="sheet">
        <div className={styles.modalBody}>
          {dialog === 'name' ? <NameChangeForm onClose={closeDialog} onSaved={() => { closeDialog(); setSuccessMessage(t('account.details.nameSaved')); }} /> : null}
          {dialog === 'password' ? <PasswordChangeForm /> : null}
          {dialog === 'email' ? <EmailChangeForm onClose={closeDialog} /> : null}
        </div>
      </Modal>
    </section>
  );
}
