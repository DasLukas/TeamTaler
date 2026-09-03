import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FinanceStatistics, MemberStatistics, StatisticsMeta } from '@/api/types';
import { FinanceStatisticsView } from './FinanceStatisticsView';
import { MemberStatisticsView } from './MemberStatisticsView';

vi.mock('./components/MemberActivityChart', () => ({ MemberActivityChart: () => <div data-testid="member-activity-chart" /> }));
vi.mock('./components/TrendRanking', () => ({ TrendRanking: ({ data, title }: { data: Array<{ label: string; context?: string }>; title: string }) => (
  <section aria-label={title} data-testid={`trend-${title}`}>
    {data.map((item) => <span key={`${item.label}-${item.context ?? ''}`}>{item.label}{item.context ? ` · ${item.context}` : ''}</span>)}
  </section>
) }));
vi.mock('./components/FinanceTrendChart', () => ({ FinanceTrendChart: () => <div data-testid="finance-trend-chart" /> }));

const meta: StatisticsMeta = {
  generatedAt: '2026-08-28T10:00:00Z', timezone: 'Europe/Berlin', preset: 'LAST_30_DAYS' as const,
  fromInclusive: '2026-07-30T00:00:00Z', toExclusive: '2026-08-29T00:00:00Z', bucket: 'DAY' as const,
  privacyThresholdApplied: false, currentPeriodAvailable: false,
};

function memberStatistics(): MemberStatistics {
  return {
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
    data.topCategories = { suppressed: true, items: [] };
    data.topProducts = { suppressed: true, items: [] };
    render(<MemberStatisticsView data={data} meta={{ ...meta, privacyThresholdApplied: true }} />);

    expect(screen.getByText('Datenschutzschwelle angewendet')).toBeVisible();
    expect(screen.getAllByText('Diese Auswertung wird zum Schutz einzelner Mitglieder nicht angezeigt.')).toHaveLength(2);
    expect(screen.getByText('Im ausgewählten Zeitraum wurden keine Produkte gebucht oder storniert.')).toBeVisible();
    expect(screen.queryByTestId('member-activity-chart')).not.toBeInTheDocument();
  });

  it('localizes the synthetic non-navigable Other ranking item', () => {
    const data = memberStatistics();
    data.topCategories.items = [{ categoryId: '', categoryName: 'Other', icon: 'other', validBookedUnits: 4, isOther: true, series: [] }];
    render(<MemberStatisticsView data={data} meta={meta} />);

    expect(screen.getByText('Weitere')).toBeVisible();
    expect(screen.queryByText('Zusammensetzung')).not.toBeInTheDocument();
  });

  it('prioritizes product and category planning before booking activity', () => {
    const data = memberStatistics();
    data.activity = [{ periodStart: '2026-08-01T00:00:00Z', postedUnits: 2, reversedUnits: 0 }];
    data.topProducts.items = [{ productId: 'product-water', productName: 'Wasser', categoryId: 'category-drinks', categoryName: 'Getränke', validBookedUnits: 2, isOther: false, series: [] }];
    data.topCategories.items = [{ categoryId: 'category-drinks', categoryName: 'Getränke', icon: 'drink', validBookedUnits: 2, isOther: false, series: [] }];
    render(<MemberStatisticsView data={data} meta={meta} />);

    const product = screen.getByTestId('trend-Beliebte Produkte');
    const category = screen.getByTestId('trend-Beliebte Kategorien');
    const activity = screen.getByTestId('member-activity-chart');
    expect(product.compareDocumentPosition(category) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(category.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Wasser · Getränke')).toBeVisible();
  });

  it('keeps overdue context while omitting removed finance analysis panels', () => {
    const { container } = render(<FinanceStatisticsView data={financeStatistics()} meta={meta} />);

    expect(screen.getByText(/Aktueller Stand: 28\.08\.2026/)).toHaveTextContent('1 Konto in 2 Abrechnungszeiträumen');
    expect(screen.getByText('Einzahlungen im Zeitraum')).toBeVisible();
    expect(container.querySelectorAll('dl[aria-label="Wichtigste Finanzzahlen"] > div')).toHaveLength(2);
    expect(screen.queryByText('Finanzbewegungen')).not.toBeInTheDocument();
    expect(screen.queryByText('Abstimmung des Gruppensaldos')).not.toBeInTheDocument();
    expect(screen.queryByText('Buchungsbelastungen nach Kategorie')).not.toBeInTheDocument();
    expect(screen.queryByText('Status der Mitgliedskonten')).not.toBeInTheDocument();
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
    render(<FinanceStatisticsView data={data} meta={meta} />);

    expect(screen.getByTestId('finance-trend-chart')).toBeVisible();
  });

  it('limits the booking overview to two distinct headline values', () => {
    const { container } = render(<MemberStatisticsView data={memberStatistics()} meta={meta} />);

    expect(container.querySelectorAll('dl[aria-label="Wichtigste Buchungszahlen"] > div')).toHaveLength(2);
    expect(screen.queryByText('Erstellte Buchungen')).not.toBeInTheDocument();
    expect(screen.getByText('Gebuchte Produkte')).toBeVisible();
    expect(screen.queryByText('Stornoquote')).not.toBeInTheDocument();
  });
});
