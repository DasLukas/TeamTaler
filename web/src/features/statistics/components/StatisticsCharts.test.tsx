import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { FinanceStatisticsSeriesPoint, Money, StatisticsMeta } from '@/api/types';
import { FinanceTrendChart } from './FinanceTrendChart';
import { MemberActivityChart } from './MemberActivityChart';

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
  ['member activity', () => <MemberActivityChart activity={[
    { periodStart: '2026-08-01T00:00:00Z', postedUnits: 3, reversedUnits: 1 },
    { periodStart: '2026-08-02T00:00:00Z', postedUnits: 2, reversedUnits: 0 },
  ]} meta={meta} summary="Summary" />],
  ['finance trend', () => <FinanceTrendChart currency="EUR" meta={meta} series={financeSeries} summary="Summary" />],
];

describe('statistics chart geometry', () => {
  it.each(chartCases)('fills the available plot area for %s', (_name, createChart) => {
    const { container } = render(createChart());
    const wrapper = container.querySelector('.recharts-wrapper');

    expect(wrapper).toHaveStyle({ width: '100%', height: '100%' });
  });

  it('keeps activity totals and an assistive series description visible without hover', () => {
    const { container } = render(<MemberActivityChart activity={[
      { periodStart: '2026-08-01T00:00:00Z', postedUnits: 3, reversedUnits: 1 },
      { periodStart: '2026-08-02T00:00:00Z', postedUnits: 2, reversedUnits: 0 },
    ]} meta={meta} summary="Summary" />);

    expect(screen.getByText('5', { selector: 'dd' })).toBeVisible();
    expect(screen.getByText('1', { selector: 'dd' })).toBeVisible();
    expect(screen.getAllByText('Im Zeitraum')).toHaveLength(2);
    expect(screen.getByText('01.08.: 3 gebucht, 1 storniert. 02.08.: 2 gebucht, 0 storniert.')).toHaveClass('sr-only');
    expect(container.querySelector('.recharts-wrapper')?.parentElement).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('details')).not.toBeInTheDocument();
  });

  it('shows the finance trend endpoints and exposes its exact series to screen readers', () => {
    const { container } = render(<FinanceTrendChart currency="EUR" meta={meta} series={financeSeries} summary="Summary" />);

    expect(screen.getByText(/12,00\s€/, { selector: 'dd' })).toBeVisible();
    expect(screen.getByText(/14,00\s€/, { selector: 'dd' })).toBeVisible();
    expect(screen.getByText('01.08.: 12,00 € offener Gruppensaldo. 02.08.: 14,00 € offener Gruppensaldo.')).toHaveClass('sr-only');
    expect(container.querySelector('.recharts-wrapper')?.parentElement).toHaveAttribute('aria-hidden', 'true');
  });

  it('does not imply a trend from a single activity bucket', () => {
    const { container } = render(<MemberActivityChart activity={[
      { periodStart: '2026-08-01T00:00:00Z', postedUnits: 3, reversedUnits: 1 },
    ]} meta={meta} summary="Summary" />);

    expect(screen.getByText('Ein einzelner Zeitabschnitt liefert Werte, aber noch keinen belastbaren Verlauf.')).toBeVisible();
    expect(screen.getByText('3', { selector: 'dd' })).toBeVisible();
    expect(screen.getByText('1', { selector: 'dd' })).toBeVisible();
    expect(container.querySelector('.recharts-wrapper')).not.toBeInTheDocument();
  });
});
