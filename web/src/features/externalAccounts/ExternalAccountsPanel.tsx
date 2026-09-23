import { useQuery } from '@tanstack/react-query';
import WalletCards from 'lucide-react/dist/esm/icons/wallet-cards';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney } from '@/api/money';
import type { ExternalAccount } from '@/api/types';
import { can } from '@/app/permissions';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Button } from '@/components/ui/Button';
import { StatePanel } from '@/components/ui/StatePanel';
import { ExternalAccountTypeIcon } from './ExternalAccountTypeIcon';
import { externalAccountDescriptor } from './externalAccountPresentation';
import { externalAccountKeys } from './externalAccountQueryKeys';
import { ExternalTransactionDialog } from './ExternalTransactionDialog';
import { ExternalTransactionHistory } from './ExternalTransactionHistory';
import { useExternalAccountAccessBoundary } from './useExternalAccountAccessBoundary';
import styles from './ExternalAccountsPanel.module.css';

interface ExternalAccountCardProps {
  account: ExternalAccount;
  paymentMethodLabels: ReadonlyMap<string, string>;
}

/** Renders one size-stable operational account card with balance and payment-method context. */
function ExternalAccountCard({ account, paymentMethodLabels }: ExternalAccountCardProps) {
  const { t } = useTranslation();
  const descriptor = externalAccountDescriptor(account);
  const balanceMinor = BigInt(account.balance.minorUnits);
  const balanceTone = balanceMinor > 0n ? 'positive' : balanceMinor < 0n ? 'negative' : 'neutral';

  return <article className={styles.accountCard} data-account-type={account.type} data-balance-tone={balanceTone}>
    <header><div><strong>{account.name}</strong><span>{t(`externalAccounts.types.${account.type}`)}</span></div><span className={styles.accountIcon} data-account-icon={account.type}><ExternalAccountTypeIcon size={22} type={account.type} /></span></header>
    <div className={styles.descriptor}>{descriptor ? <small>{descriptor}</small> : null}</div>
    <div className={styles.balance}><span>{t('externalAccounts.balance')}</span><strong>{formatMoney(account.balance)}</strong></div>
    <div className={styles.paymentMethods}>{account.linkedPaymentMethodIds.length > 0 ? <div className={styles.chips}>{account.linkedPaymentMethodIds.map((id) => <span key={id}>{paymentMethodLabels.get(id) ?? id}</span>)}</div> : <small>{t('externalAccounts.noLinkedMethods')}</small>}</div>
  </article>;
}

/** Renders the operational external-account workspace with balances, financial flows, and immutable history. */
export function ExternalAccountsPanel() {
  const { t } = useTranslation();
  const { activeGroup, activeGroupId } = useActiveGroup();
  const grants = activeGroup.membership?.effectiveGrants;
  const canManage = can(grants, 'MANAGE_EXTERNAL_ACCOUNTS');
  const [transactionDialog, setTransactionDialog] = useState(false);
  const { accessRevoked, guard: guardSensitiveQuery, handleError: handleAccessError } = useExternalAccountAccessBoundary(activeGroupId);

  const accountsQuery = useQuery({ queryKey: externalAccountKeys.list(activeGroupId), queryFn: () => guardSensitiveQuery(() => api.getExternalAccounts(activeGroupId)), enabled: !accessRevoked });
  const settingsQuery = useQuery({ queryKey: ['transaction-settings', activeGroupId], queryFn: () => api.getTransactionSettings(activeGroupId) });
  const accounts = accountsQuery.data?.items ?? [];
  const activeAccounts = accounts.filter((account) => account.status === 'ACTIVE');
  const archivedAccounts = accounts.filter((account) => account.status === 'ARCHIVED');
  const paymentMethodLabels = useMemo(() => new Map((settingsQuery.data?.paymentMethods ?? []).map((method) => [method.id, method.label])), [settingsQuery.data?.paymentMethods]);
  if (!activeGroup.externalAccountsEnabled) return <StatePanel kind="empty" message={t('externalAccounts.disabledMessage')} title={t('externalAccounts.disabledTitle')} />;
  if (!can(grants, 'VIEW_EXTERNAL_ACCOUNTS')) return <StatePanel kind="error" message={t('externalAccounts.noAccessMessage')} title={t('financeWorkspace.noAccessTitle')} />;
  if (accountsQuery.isLoading || settingsQuery.isLoading) return <StatePanel kind="loading" />;
  if (accessRevoked || accountsQuery.isError || settingsQuery.isError || !settingsQuery.data) {
    return <StatePanel actionLabel={accessRevoked ? t('common.retry') : undefined} kind="error" message={t(accessRevoked ? 'externalAccounts.noAccessMessage' : 'finance.error')} onAction={accessRevoked ? () => window.location.reload() : undefined} />;
  }

  return <div className={styles.content}>
    <header className={styles.header}><div><h2>{t('externalAccounts.title')}</h2><p>{t('externalAccounts.intro')}</p></div>{canManage ? <div className={styles.headerActions}><Button disabled={activeAccounts.length === 0} leadingIcon={<WalletCards size={17} />} onClick={() => setTransactionDialog(true)}>{t('externalAccounts.recordTransaction')}</Button></div> : null}</header>
    {accounts.length === 0 ? <StatePanel kind="empty" message={t('externalAccounts.emptyAccounts')} title={t('externalAccounts.emptyAccountsTitle')} /> : <>
      <section aria-labelledby="external-account-active-title"><div className={styles.sectionHeading}><h3 id="external-account-active-title">{t('externalAccounts.activeAccounts')}</h3></div><div className={styles.accountGrid}>{activeAccounts.map((account) => <ExternalAccountCard account={account} key={account.id} paymentMethodLabels={paymentMethodLabels} />)}</div></section>
      {archivedAccounts.length > 0 ? <details className={styles.archived}><summary>{t('externalAccounts.archivedAccounts', { count: archivedAccounts.length })}</summary><div className={styles.accountGrid}>{archivedAccounts.map((account) => <ExternalAccountCard account={account} key={account.id} paymentMethodLabels={paymentMethodLabels} />)}</div></details> : null}
      <ExternalTransactionHistory accounts={accounts} canManage={canManage} canOpenPayments={can(grants, 'FINANCE_MANAGEMENT')} currency={activeGroup.currency} groupId={activeGroupId} onAccessError={handleAccessError} />
    </>}
    {transactionDialog ? <ExternalTransactionDialog accounts={activeAccounts} currency={activeGroup.currency} groupId={activeGroupId} onAccessError={handleAccessError} onClose={() => setTransactionDialog(false)} /> : null}
  </div>;
}
