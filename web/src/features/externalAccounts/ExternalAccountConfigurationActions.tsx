import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Archive from 'lucide-react/dist/esm/icons/archive';
import Edit3 from 'lucide-react/dist/esm/icons/edit-3';
import HandCoins from 'lucide-react/dist/esm/icons/hand-coins';
import Plus from 'lucide-react/dist/esm/icons/plus';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney } from '@/api/money';
import type { ExternalAccount, ExternalAccountCollection, PaymentMethod } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { ExternalAccountDialog } from './ExternalAccountDialog';
import { externalAccountDescriptor } from './externalAccountPresentation';
import { externalAccountKeys } from './externalAccountQueryKeys';
import { useExternalAccountAccessBoundary } from './useExternalAccountAccessBoundary';
import styles from './ExternalAccountConfigurationActions.module.css';

/** Properties accepted by the external-account settings actions. */
export interface ExternalAccountConfigurationActionsProps {
  accounts: ExternalAccountCollection;
  currency: string;
  groupId: string;
  paymentMethods: PaymentMethod[];
}

type LifecycleAction = 'archive' | 'delete' | 'reactivate';

/** Renders all account configuration and lifecycle actions inside group finance settings. */
export function ExternalAccountConfigurationActions({ accounts, currency, groupId, paymentMethods }: ExternalAccountConfigurationActionsProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const configurationTitleId = useId();
  const accountsTitleId = useId();
  const activeAccountsTitleId = useId();
  const archivedAccountsTitleId = useId();
  const unlinkedMethodsTitleId = useId();
  const [accountDialog, setAccountDialog] = useState<ExternalAccount | 'create'>();
  const [lifecycle, setLifecycle] = useState<{ account: ExternalAccount; action: LifecycleAction }>();
  const { accessRevoked, guard: guardSensitiveQuery, handleError: handleAccessError } = useExternalAccountAccessBoundary(groupId);
  const linksQuery = useQuery({
    queryKey: externalAccountKeys.links(groupId),
    queryFn: () => guardSensitiveQuery(() => api.getExternalAccountLinks(groupId)),
    enabled: !accessRevoked,
  });
  const activeAccounts = accounts.items.filter((account) => account.status === 'ACTIVE');
  const archivedAccounts = accounts.items.filter((account) => account.status === 'ARCHIVED');
  const accountsById = new Map(accounts.items.map((account) => [account.id, account]));
  const projectedLinks = accounts.items.flatMap((account) => account.linkedPaymentMethodIds.map((paymentMethodId) => ({ paymentMethodId, externalAccountId: account.id })));
  const linkedAccountIds = new Map((linksQuery.data?.links ?? projectedLinks).map((link) => [link.paymentMethodId, link.externalAccountId]));
  const unlinkedPaymentMethods = paymentMethods.filter((method) => !accountsById.has(linkedAccountIds.get(method.id) ?? ''));
  const lifecyclePaymentMethods = lifecycle?.action === 'archive'
    ? paymentMethods.filter((method) => linkedAccountIds.get(method.id) === lifecycle.account.id)
    : [];
  const deleteHasRemainingBalance = lifecycle?.action === 'delete' && BigInt(lifecycle.account.balance.minorUnits) !== 0n;
  const lifecycleMessage = deleteHasRemainingBalance
    ? t('externalAccounts.lifecycle.deleteBalanceMessage', { name: lifecycle.account.name, balance: formatMoney(lifecycle.account.balance) })
    : lifecycle?.action === 'delete' && lifecycle.account.hasTransactions
      ? t('externalAccounts.lifecycle.deleteHistoricalMessage', { name: lifecycle.account.name })
      : lifecycle?.action === 'archive' && lifecyclePaymentMethods.length > 0
    ? t('externalAccounts.lifecycle.archiveLinkedMessage', {
      name: lifecycle.account.name,
      count: lifecyclePaymentMethods.length,
      paymentMethods: lifecyclePaymentMethods.map((method) => method.label).join(', '),
    })
    : t(`externalAccounts.lifecycle.${lifecycle?.action ?? 'archive'}Message`, { name: lifecycle?.account.name ?? '' });
  const lifecycleMutation = useMutation({
    mutationFn: async ({ account, action }: { account: ExternalAccount; action: LifecycleAction }) => {
      if (action === 'archive') return api.archiveExternalAccount(groupId, account.id, accounts.version);
      if (action === 'reactivate') return api.reactivateExternalAccount(groupId, account.id, accounts.version);
      await api.deleteExternalAccount(groupId, account.id, accounts.version);
      return undefined;
    },
    onError: (error) => { handleAccessError(error); },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: externalAccountKeys.all(groupId) }),
        queryClient.invalidateQueries({ queryKey: ['group-settings', groupId] }),
        queryClient.invalidateQueries({ queryKey: ['transaction-settings', groupId] }),
      ]);
      setLifecycle(undefined);
    },
  });
  const renderAccount = (account: ExternalAccount) => {
    const descriptor = externalAccountDescriptor(account);
    const negative = BigInt(account.balance.minorUnits) < 0n;
    const linkedPaymentMethodsForAccount = paymentMethods.filter((method) => linkedAccountIds.get(method.id) === account.id);
    return <li className={styles.accountRow} data-status={account.status} key={account.id}>
      <div className={styles.accountIdentity}>
        <div className={styles.accountName}><strong>{account.name}</strong><span data-status={account.status}>{t(`externalAccounts.statuses.${account.status}`)}</span></div>
        <div className={styles.accountMeta}><span><strong>{t('externalAccounts.accountTypeLabel')}:</strong> {t(`externalAccounts.types.${account.type}`)}</span>{descriptor ? <span>{descriptor}</span> : null}</div>
        <div className={styles.accountMethods}>
          <span>{t('externalAccounts.linkedPaymentMethods')}</span>
          {linkedPaymentMethodsForAccount.length > 0 ? <div className={styles.methodChips}>{linkedPaymentMethodsForAccount.map((method) => <span key={method.id}>{method.label}</span>)}</div> : <small>{t('externalAccounts.noLinkedMethods')}</small>}
        </div>
      </div>
      <div className={styles.accountBalance} data-negative={negative}><span>{t('externalAccounts.balance')}</span><strong>{formatMoney(account.balance)}</strong></div>
      <div className={styles.accountActions}>
        {account.status === 'ACTIVE' ? <Button leadingIcon={<Edit3 size={15} />} onClick={() => setAccountDialog(account)} size="small" variant="ghost">{t('common.edit')}</Button> : null}
        {account.canArchive ? <Button leadingIcon={<Archive size={15} />} onClick={() => setLifecycle({ account, action: 'archive' })} size="small" variant="ghost">{t('externalAccounts.archive')}</Button> : null}
        {account.canReactivate ? <Button leadingIcon={<RotateCcw size={15} />} onClick={() => setLifecycle({ account, action: 'reactivate' })} size="small" variant="ghost">{t('externalAccounts.reactivate')}</Button> : null}
        {account.status === 'ARCHIVED' ? <Button leadingIcon={<Trash2 size={15} />} onClick={() => setLifecycle({ account, action: 'delete' })} size="small" variant="ghost">{t('externalAccounts.deleteAccount')}</Button> : null}
      </div>
    </li>;
  };

  return <section aria-labelledby={configurationTitleId} className={styles.configuration}>
    <div className={styles.heading}>
      <div><h4 id={configurationTitleId}>{t('externalAccounts.configurationTitle')}</h4><p>{t('externalAccounts.configurationDescription')}</p></div>
      <div className={styles.actions}>
        <Button disabled={accessRevoked} leadingIcon={<Plus size={17} />} onClick={() => setAccountDialog('create')}>{t('externalAccounts.createAccount')}</Button>
      </div>
    </div>
    {linksQuery.isError && !accessRevoked ? <p className={styles.error} role="alert">{t('externalAccounts.linksUnavailable')}</p> : null}
    {accessRevoked ? <p className={styles.error} role="alert">{t('externalAccounts.noAccessMessage')}</p> : null}
    <section aria-labelledby={accountsTitleId} className={styles.accountOverview}>
      <div className={styles.accountOverviewHeading}>
        <h5 id={accountsTitleId}>{t('externalAccounts.configuredAccounts')}</h5>
      </div>
      {accounts.items.length === 0 ? <div className={styles.emptyAccounts}><strong>{t('externalAccounts.emptyAccountsTitle')}</strong><span>{t('externalAccounts.emptyAccounts')}</span></div> : <div className={styles.accountGroups}>
        <section aria-labelledby={activeAccountsTitleId} className={styles.accountGroup}>
          <div className={styles.accountGroupHeading}>
            <h6 id={activeAccountsTitleId}>{t('externalAccounts.activeAccounts')}</h6>
            <span aria-label={t('externalAccounts.accountGroupCount', { count: activeAccounts.length })}>{activeAccounts.length}</span>
          </div>
          {activeAccounts.length > 0 ? <ul className={styles.accountList}>{activeAccounts.map(renderAccount)}</ul> : <p className={styles.emptyAccountGroup}>{t('externalAccounts.noActiveAccounts')}</p>}
        </section>
        {unlinkedPaymentMethods.length > 0 ? <aside aria-labelledby={unlinkedMethodsTitleId} className={styles.unlinkedMethodsRow} role="note">
          <span aria-hidden="true" className={styles.unlinkedMethodsIcon}><HandCoins size={21} /></span>
          <div className={styles.unlinkedMethodsCopy}><strong id={unlinkedMethodsTitleId}>{t('externalAccounts.unlinkedPaymentMethods')}</strong><span>{t('externalAccounts.unlinkedPaymentMethodsHint')}</span></div>
          <div className={styles.methodChips}>{unlinkedPaymentMethods.map((method) => <span key={method.id}>{method.label}</span>)}</div>
        </aside> : null}
        {archivedAccounts.length > 0 ? <section aria-labelledby={archivedAccountsTitleId} className={styles.accountGroup} data-status="ARCHIVED">
          <div className={styles.accountGroupHeading}>
            <h6 id={archivedAccountsTitleId}>{t('externalAccounts.archivedAccountsTitle')}</h6>
            <span aria-label={t('externalAccounts.accountGroupCount', { count: archivedAccounts.length })}>{archivedAccounts.length}</span>
          </div>
          <ul className={styles.accountList}>{archivedAccounts.map(renderAccount)}</ul>
        </section> : null}
      </div>}
    </section>
    {accountDialog ? <ExternalAccountDialog account={accountDialog === 'create' ? undefined : accountDialog} collectionVersion={accounts.version} currency={currency} groupId={groupId} onAccessError={handleAccessError} onClose={() => setAccountDialog(undefined)} paymentMethods={paymentMethods} /> : null}
    <ConfirmationDialog
      confirmIcon={deleteHasRemainingBalance || lifecycle?.action === 'reactivate' ? <RotateCcw size={17} /> : lifecycle?.action === 'delete' ? <Trash2 size={17} /> : <Archive size={17} />}
      confirmLabel={t(deleteHasRemainingBalance || lifecycle?.action === 'reactivate' ? 'externalAccounts.reactivateAccount' : lifecycle?.action === 'delete' ? 'externalAccounts.deleteAccount' : 'externalAccounts.archive')}
      errorMessage={lifecycleMutation.isError ? lifecycleMutation.error.message : undefined}
      message={lifecycleMessage}
      onClose={() => setLifecycle(undefined)}
      onConfirm={() => lifecycle && lifecycleMutation.mutate(deleteHasRemainingBalance ? { account: lifecycle.account, action: 'reactivate' } : lifecycle)}
      open={Boolean(lifecycle)}
      pending={lifecycleMutation.isPending}
      title={t(deleteHasRemainingBalance ? 'externalAccounts.lifecycle.deleteBalanceTitle' : `externalAccounts.lifecycle.${lifecycle?.action ?? 'archive'}Title`)}
      tone={deleteHasRemainingBalance || lifecycle?.action === 'reactivate' ? 'default' : 'danger'}
    />
  </section>;
}
