import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FinanceStatistics, MemberStatistics } from '@/api/types';
import { FinanceStatisticsView } from './FinanceStatisticsView';
import { MemberStatisticsView } from './MemberStatisticsView';

vi.mock('./components/CompositionChart', () => ({ CompositionChart: () => <div data-testid="composition-chart" /> }));
vi.mock('./components/MemberActivityChart', () => ({ MemberActivityChart: () => <div data-testid="member-activity-chart" /> }));
vi.mock('./components/RankedBarChart', () => ({ RankedBarChart: ({ data }: { data: Array<{ label: string }> }) => <div>{data.map((item) => item.label).join(', ')}</div> }));
vi.mock('./components/FinanceTrendChart', () => ({ FinanceTrendChart: () => <div data-testid="finance-trend-chart" /> }));
vi.mock('./components/FinanceFlowsChart', () => ({ FinanceFlowsChart: () => <div data-testid="finance-flows-chart" /> }));
vi.mock('./components/SignedCategoryChart', () => ({ SignedCategoryChart: () => <div data-testid="finance-category-chart" /> }));
vi.mock('./components/AccountStateChart', () => ({ AccountStateChart: ({ summary }: { summary: string }) => <div>{summary}</div> }));

const meta = {
  generatedAt: '2026-08-28T10:00:00Z', timezone: 'Europe/Berlin', preset: 'LAST_30_DAYS' as const,
  fromInclusive: '2026-07-30T00:00:00Z', toExclusive: '2026-08-29T00:00:00Z', bucket: 'DAY' as const,
  privacyThresholdApplied: false, currentPeriodAvailable: false,
};

function memberStatistics(): MemberStatistics {
  return {
    meta,
    memberSnapshot: { regularMembers: 2, temporaryGuests: 0, asOf: meta.generatedAt },
    summary: { activeParticipants: 1, bookingCount: 1, validBookedUnits: 0, cancellationRate: 1 },
    activity: [{ periodStart: '2026-08-01T00:00:00Z', postedUnits: 0, reversedUnits: 0 }],
    topCategories: { suppressed: false, items: [] },
    topProducts: { suppressed: false, items: [] },
  };
}

function financeStatistics(): FinanceStatistics {
  const money = (minorUnits: string) => ({ minorUnits, currency: 'EUR' });
  return {
    meta,
    currency: 'EUR',
    receivableSnapshot: { asOf: meta.toExclusive, grossReceivable: money('15'), memberCredit: money('3'), netReceivable: money('12'), openAccountCount: 1, balancedAccountCount: 1, creditAccountCount: 0 },
    flows: { openingNetReceivable: money('1000'), netBookingCharges: money('500'), netPayments: money('200'), netAdjustments: money('-100'), closingNetReceivable: money('1200') },
    series: [{ periodStart: '2026-08-01T00:00:00Z', netBookingCharges: money('500'), netPayments: money('200'), netAdjustments: money('-100'), closingNetReceivable: money('1200') }],
    categories: [],
    overdue: { amount: money('250'), accountCount: 1, periodCount: 2, asOf: meta.generatedAt },
  };
}

describe('statistics projection views', () => {
  it('renders privacy suppression and honest zero-series states without a misleading chart', () => {
    const data = memberStatistics();
    data.meta = { ...data.meta, privacyThresholdApplied: true };
    data.topCategories = { suppressed: true, items: [] };
    data.topProducts = { suppressed: true, items: [] };
    render(<MemberStatisticsView data={data} />);

    expect(screen.getByText('Datenschutzschwelle angewendet')).toBeVisible();
    expect(screen.getAllByText('Diese Rangfolge wird zum Schutz einzelner Mitglieder nicht angezeigt.')).toHaveLength(2);
    expect(screen.getByText('Im ausgewählten Zeitraum gab es keine gebuchten oder stornierten Einheiten.')).toBeVisible();
    expect(screen.queryByTestId('member-activity-chart')).not.toBeInTheDocument();
  });

  it('localizes the synthetic non-navigable Other ranking item', () => {
    const data = memberStatistics();
    data.topCategories.items = [{ categoryId: '', categoryName: 'Other', icon: 'other', validBookedUnits: 4, isOther: true }];
    render(<MemberStatisticsView data={data} />);

    expect(screen.getByText('Weitere')).toBeVisible();
  });

  it('shows the exact payment subtraction and distinguishes current overdue data from range data', () => {
    render(<FinanceStatisticsView data={financeStatistics()} />);

    expect(screen.getByText((_, element) => element?.textContent === '10,00 € + (+5,00 €) − (+2,00 €) + (−1,00 €) = 12,00 €')).toBeVisible();
    expect(screen.getByText(/Aktueller Stand: 28\.08\.2026/)).toHaveTextContent('1 Konto in 2 Abrechnungszeiträumen');
    expect(screen.getByText(/Verteilung von insgesamt 2 Mitgliedskonten/)).toHaveTextContent('am Ende des ausgewählten Zeitraums');
  });

  it('keeps a zero-closing trend visible when offsetting movements occurred', () => {
    const data = financeStatistics();
    data.flows = { ...data.flows, openingNetReceivable: { minorUnits: '0', currency: 'EUR' }, closingNetReceivable: { minorUnits: '0', currency: 'EUR' } };
    data.series = [{
      ...data.series[0],
      netBookingCharges: { minorUnits: '100', currency: 'EUR' },
      netPayments: { minorUnits: '100', currency: 'EUR' },
      closingNetReceivable: { minorUnits: '0', currency: 'EUR' },
    }];
    render(<FinanceStatisticsView data={data} />);

    expect(screen.getByTestId('finance-trend-chart')).toBeVisible();
  });
});
