import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from 'recharts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExternalAccountStatisticsAccount, ExternalAccountsStatistics, Money, StatisticsMeta } from '@/api/types';
import { formatMoney } from '@/api/money';
import { ChartFrame } from './components/ChartFrame';
import { responsiveStatisticsChartProps } from './components/chartTheme';
import { createMoneyChartScale, formatStatisticsPeriod } from './statisticsFormat';
import styles from './ExternalAccountsStatisticsView.module.css';

/** Properties of the compact, permission-gated account overview. */
export interface ExternalAccountsStatisticsViewProps {
  data: ExternalAccountsStatistics;
  meta: StatisticsMeta;
}

/**
 * Returns the exact signed balance change over the selected interval.
 *
 * @param account - Authorized account with opening and closing balances.
 * @returns Exact money without a floating-point conversion.
 */
function accountChange(account: ExternalAccountStatisticsAccount): Money {
  return {
    minorUnits: (BigInt(account.closingBalance.minorUnits) - BigInt(account.openingBalance.minorUnits)).toString(),
    currency: account.closingBalance.currency,
  };
}

/**
 * Renders a single selected account's bounded, accessible balance trend.
 *
 * @param props - Account and server-resolved range metadata.
 * @returns A labeled chart and exact textual balances.
 */
function AccountBalanceChart({ account, meta }: { account: ExternalAccountStatisticsAccount; meta: StatisticsMeta }) {
  const { t } = useTranslation();
  const scale = createMoneyChartScale([account.openingBalance, ...account.series.map((point) => point.closingBalance)]);
  const data = account.series.map((point) => ({
    label: formatStatisticsPeriod(point.periodStart, meta.bucket, meta.timezone),
    amount: scale.coordinate(point.closingBalance),
    exactAmount: formatMoney(point.closingBalance),
  }));
  const coordinates = data.map((point) => point.amount);
  const minimum = Math.min(...coordinates);
  const maximum = Math.max(...coordinates);
  const spread = maximum - minimum;
  const padding = spread > 0 ? spread * 0.15 : Math.max(Math.abs(maximum) * 0.05, 1);
  const axisFormatter = new Intl.NumberFormat('de-DE', { style: 'currency', currency: account.closingBalance.currency, maximumFractionDigits: 0 });
  const negative = BigInt(account.closingBalance.minorUnits) < 0n;
  const accent = negative ? 'var(--chart-negative)' : 'var(--chart-primary)';
  return (
    <ChartFrame className={styles.chartFrame} summary={t('statistics.externalAccounts.chartSummary')} title={account.name}>
      <div className={styles.chartBody}>
        <div className={styles.chartNumbers}>
          <div><span>{t('statistics.externalAccounts.balance')}</span><strong data-negative={negative}>{formatMoney(account.closingBalance)}</strong></div>
          <div><span>{t('statistics.externalAccounts.change')}</span><strong>{formatMoney(accountChange(account))}</strong></div>
        </div>
        {data.length > 1 ? (
          <>
            <p className="sr-only">{data.map((point) => t('statistics.externalAccounts.pointSummary', { period: point.label, value: point.exactAmount })).join(' ')}</p>
            <div aria-hidden="true" className={styles.plot}>
              <AreaChart {...responsiveStatisticsChartProps} data={data} margin={{ top: 10, right: 12, bottom: 4, left: 4 }}>
                <defs><linearGradient id="external-account-balance-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={accent} stopOpacity={0.28} /><stop offset="100%" stopColor={accent} stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                <XAxis axisLine={false} dataKey="label" minTickGap={30} tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} tickLine={false} />
                <YAxis axisLine={false} domain={[minimum - padding, maximum + padding]} tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} tickFormatter={(value) => axisFormatter.format((BigInt(Math.round(Number(value))) * scale.divisor) / 100n)} tickLine={false} width={76} />
                {minimum < 0 && maximum > 0 ? <ReferenceLine stroke="var(--chart-axis)" strokeDasharray="3 5" y={0} /> : null}
                <Area dataKey="amount" dot={false} fill="url(#external-account-balance-fill)" isAnimationActive={false} stroke={accent} strokeWidth={2.5} type="linear" />
              </AreaChart>
            </div>
          </>
        ) : <p className={styles.singlePoint}>{t('statistics.externalAccounts.singlePoint')}</p>}
        <div className={styles.endpoints}><span>{t('statistics.externalAccounts.start')}: {formatMoney(account.openingBalance)}</span><span>{t('statistics.externalAccounts.end')}: {formatMoney(account.closingBalance)}</span></div>
      </div>
    </ChartFrame>
  );
}

/**
 * Presents account balances and one selectable trend without mixing accounts.
 *
 * @param props - Authorized account projection and server-resolved range.
 * @returns Keyboard-operable account choices and one accessible balance chart.
 */
export function ExternalAccountsStatisticsView({ data, meta }: ExternalAccountsStatisticsViewProps) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedAccount = data.accounts.find((account) => account.id === selectedId) ?? data.accounts[0];
  if (!selectedAccount) return <p className={styles.empty}>{t('statistics.externalAccounts.empty')}</p>;
  return (
    <div className={styles.view}>
      <div aria-label={t('statistics.externalAccounts.accountList')} className={styles.accountList}>
        {data.accounts.map((account) => {
          const change = accountChange(account);
          const negative = BigInt(account.closingBalance.minorUnits) < 0n;
          return (
            <button aria-pressed={account.id === selectedAccount.id} className={styles.accountButton} data-negative={negative} key={account.id} onClick={() => setSelectedId(account.id)} type="button">
              <span className={styles.accountTop}><strong>{account.name}</strong>{account.status === 'ARCHIVED' ? <small>{t('statistics.externalAccounts.archived')}</small> : null}</span>
              <span className={styles.accountBalance}>{formatMoney(account.closingBalance)}</span>
              <span className={styles.accountChange}>{t('statistics.externalAccounts.change')}: {formatMoney(change)}</span>
            </button>
          );
        })}
      </div>
      <AccountBalanceChart account={selectedAccount} meta={meta} />
    </div>
  );
}
