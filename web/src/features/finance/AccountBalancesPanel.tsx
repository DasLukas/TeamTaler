import { useQuery } from '@tanstack/react-query';
import Search from 'lucide-react/dist/esm/icons/search';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { formatMoney } from '@/api/money';
import type { AccountSummary } from '@/api/types';
import { useActiveGroup } from '@/app/useActiveGroup';
import { Avatar } from '@/components/ui/Avatar';
import { StatePanel } from '@/components/ui/StatePanel';
import { deriveAccountOverview } from './accountOverview';
import styles from './AccountBalancesPanel.module.css';

function balanceState(account: AccountSummary): 'due' | 'settled' | 'credit' {
  const balance = BigInt(account.balance.minorUnits);
  if (balance > 0n) return 'due';
  if (balance < 0n) return 'credit';
  return 'settled';
}

interface AccountCollectionProps {
  accounts: AccountSummary[];
  emptyMessage: string;
  title: string;
}

function AccountCollection({ accounts, emptyMessage, title }: AccountCollectionProps) {
  const { t } = useTranslation();
  if (accounts.length === 0) return <section className={styles.group}><h3>{title}</h3><p className={styles.empty}>{emptyMessage}</p></section>;
  return (
    <section className={styles.group}>
      <h3>{title} <span>{accounts.length}</span></h3>
      <div className={styles.desktopTable}>
        <table>
          <thead><tr><th>{t('common.member')}</th><th>{t('financeWorkspace.membershipStatus')}</th><th>{t('common.status')}</th><th className={styles.number}>{t('financeWorkspace.balance')}</th></tr></thead>
          <tbody>{accounts.map((account) => {
            const state = balanceState(account);
            return <tr key={account.membershipId}><td><span className={styles.member}><Avatar name={account.displayName} size="small" src={account.avatarUrl} /><strong>{account.displayName}</strong></span></td><td>{account.status === 'ACTIVE' ? t('financeWorkspace.active') : t('financeWorkspace.archived')}</td><td><span className={`${styles.state} ${styles[state]}`}>{t(`financeWorkspace.states.${state}`)}</span></td><td className={`${styles.number} ${styles.balance}`}>{formatMoney(account.balance)}</td></tr>;
          })}</tbody>
        </table>
      </div>
      <div className={styles.mobileCards}>{accounts.map((account) => {
        const state = balanceState(account);
        return (
          <article className={styles.accountCard} key={account.membershipId}>
            <Avatar name={account.displayName} src={account.avatarUrl} />
            <div className={styles.cardIdentity}><strong>{account.displayName}</strong><small>{account.status === 'ACTIVE' ? t('financeWorkspace.active') : t('financeWorkspace.archived')}</small></div>
            <div className={styles.cardBalance}><strong>{formatMoney(account.balance)}</strong><span className={`${styles.state} ${styles[state]}`}>{t(`financeWorkspace.states.${state}`)}</span></div>
          </article>
        );
      })}</div>
    </section>
  );
}

/**
 * Renders consolidated balances for all current and former group memberships.
 *
 * @returns Summary cards, search, and responsive account collections.
 */
export function AccountBalancesPanel() {
  const { t } = useTranslation();
  const { activeGroupId, activeGroup } = useActiveGroup();
  const [search, setSearch] = useState('');
  const accountsQuery = useQuery({ queryKey: ['account-summaries', activeGroupId], queryFn: () => api.getAccountSummaries(activeGroupId) });
  const filteredAccounts = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase('de-DE');
    if (!normalizedSearch) return accountsQuery.data ?? [];
    return (accountsQuery.data ?? []).filter((account) => account.displayName.toLocaleLowerCase('de-DE').includes(normalizedSearch));
  }, [accountsQuery.data, search]);
  const totals = useMemo(() => deriveAccountOverview(accountsQuery.data ?? [], activeGroup.currency), [accountsQuery.data, activeGroup.currency]);
  const visibleAccounts = useMemo(() => deriveAccountOverview(filteredAccounts, activeGroup.currency), [activeGroup.currency, filteredAccounts]);

  if (accountsQuery.isLoading) return <div className={styles.queryState}><StatePanel kind="loading" /></div>;
  if (!accountsQuery.data) return <div className={styles.queryState}><StatePanel kind="error" message={t('financeWorkspace.overviewError')} /></div>;

  const hasMatches = visibleAccounts.active.length > 0 || visibleAccounts.archived.length > 0;
  return (
    <div className={styles.content}>
      <header className={styles.header}><h2>{t('financeWorkspace.overviewTitle')}</h2><p>{t('financeWorkspace.overviewIntro')}</p></header>
      <div className={styles.summaries}>
        <article><span>{t('financeWorkspace.receivables')}</span><strong>{formatMoney(totals.receivables)}</strong></article>
        <article><span>{t('financeWorkspace.credits')}</span><strong>{formatMoney(totals.credits)}</strong></article>
        <article><span>{t('financeWorkspace.netBalance')}</span><strong>{formatMoney(totals.net)}</strong></article>
      </div>
      <label className={styles.search} htmlFor="finance-member-search"><span>{t('financeWorkspace.search')}</span><div><Search aria-hidden="true" size={19} /><input id="finance-member-search" onChange={(event) => setSearch(event.target.value)} placeholder={t('financeWorkspace.searchPlaceholder')} type="search" value={search} /></div></label>
      {hasMatches ? <><AccountCollection accounts={visibleAccounts.active} emptyMessage={t('financeWorkspace.noActiveMembers')} title={t('financeWorkspace.activeMembers')} /><AccountCollection accounts={visibleAccounts.archived} emptyMessage={t('financeWorkspace.noArchivedMembers')} title={t('financeWorkspace.archivedMembers')} /></> : <StatePanel kind="empty" message={search ? t('financeWorkspace.noSearchResults') : t('financeWorkspace.noAccounts')} />}
    </div>
  );
}
