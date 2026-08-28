import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { FinanceStatisticsSeriesPoint, Money, StatisticsMeta } from '@/api/types';
import { AccountStateChart } from './AccountStateChart';
import { CompositionChart } from './CompositionChart';
import { FinanceFlowsChart } from './FinanceFlowsChart';
import { FinanceTrendChart } from './FinanceTrendChart';
import { MemberActivityChart } from './MemberActivityChart';
import { RankedBarChart } from './RankedBarChart';
import { SignedCategoryChart } from './SignedCategoryChart';
import { createMoneyChartScale } from '../statisticsFormat';

const meta: StatisticsMeta = {
  generatedAt: '2026-08-28T10:00:00Z',
  timezone: 'Europe/Berlin',
  preset: 'LAST_30_DAYS',
  fromInclusive: '2026-07-30T00:00:00Z',
  toExclusive: '2026-08-29T00:00:00Z',
  bucket: 'DAY',
  privacyThresholdApplied: false,
  currentPeriodAvailable: false,
};

const money = (minorUnits: string): Money => ({ minorUnits, currency: 'EUR' });
const financeSeries: FinanceStatisticsSeriesPoint[] = [
  { periodStart: '2026-08-01T00:00:00Z', netBookingCharges: money('500'), netPayments: money('200'), netAdjustments: money('-100'), closingNetReceivable: money('1200') },
  { periodStart: '2026-08-02T00:00:00Z', netBookingCharges: money('300'), netPayments: money('100'), netAdjustments: money('0'), closingNetReceivable: money('1400') },
];

const chartCases: Array<[string, () => ReactElement]> = [
  ['member composition', () => <CompositionChart regularMembers={5} summary="Summary" temporaryGuests={2} />],
  ['member activity', () => <MemberActivityChart activity={[{ periodStart: '2026-08-01T00:00:00Z', postedUnits: 3, reversedUnits: 1 }]} meta={meta} summary="Summary" />],
  ['member ranking', () => <RankedBarChart data={[{ id: 'one', label: 'One', value: 3, formattedValue: '3' }]} summary="Summary" title="Title" valueLabel="Value" />],
  ['finance trend', () => <FinanceTrendChart currency="EUR" meta={meta} series={financeSeries} summary="Summary" />],
  ['finance flows', () => <FinanceFlowsChart currency="EUR" meta={meta} series={financeSeries} summary="Summary" />],
  ['finance categories', () => {
    const scale = createMoneyChartScale([money('300')]);
    return <SignedCategoryChart currency="EUR" data={[{ id: 'one', label: 'One', value: scale.coordinate(money('300')), formattedValue: '3.00 EUR' }]} scale={scale} summary="Summary" />;
  }],
  ['account states', () => <AccountStateChart balancedAccounts={2} creditAccounts={1} openAccounts={3} summary="Summary" />],
];

describe('statistics chart geometry', () => {
  it.each(chartCases)('fills the available plot area for %s', (_name, createChart) => {
    const { container } = render(createChart());
    const wrapper = container.querySelector('.recharts-wrapper');

    expect(wrapper).toHaveStyle({ width: '100%', height: '100%' });
  });
});
