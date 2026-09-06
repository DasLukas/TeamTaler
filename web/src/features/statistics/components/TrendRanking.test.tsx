import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MemberStatisticsBreakdownPoint } from '@/api/types';
import { TrendRanking } from './TrendRanking';

function point(day: number, validBookedUnits: number | null, options: Partial<MemberStatisticsBreakdownPoint> = {}): MemberStatisticsBreakdownPoint {
  return {
    periodStart: `2026-08-${String(day).padStart(2, '0')}T00:00:00Z`,
    validBookedUnits,
    privacySuppressed: false,
    isPartial: false,
    ...options,
  };
}

describe('TrendRanking', () => {
  it('shows a simple labelled total, bar, and privacy-aware microtrend', () => {
    const { container } = render(<TrendRanking
      data={[{
        id: 'water',
        label: 'Wasser in einer sehr langen Produktbezeichnung',
        context: 'Getränke',
        value: 7,
        isOther: false,
        series: [
          point(1, 2),
          point(2, null, { privacySuppressed: true }),
          point(3, 5, { isPartial: true }),
        ],
      }]}
      summary="Vergangene Buchungen"
      title="Beliebte Produkte"
      valueLabel="Produkte"
    />);

    expect(screen.getByText('Wasser in einer sehr langen Produktbezeichnung')).toBeVisible();
    expect(screen.getByText('Getränke')).toBeVisible();
    expect(screen.getByText('7')).toBeVisible();
    expect(screen.getByText('3 Zeitabschnitte. Erster sichtbarer Wert: 2, letzter sichtbarer Wert: 5.')).toHaveClass('sr-only');
    expect(screen.getByText((_, element) => element?.tagName === 'SMALL' && element.textContent === 'Geschützte Zeitabschnitte · Laufender Zeitabschnitt')).toBeVisible();
    expect(container.querySelector('details')).not.toBeInTheDocument();
    expect(screen.queryByText(/[+−]?\d+ %/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Hälfte/)).not.toBeInTheDocument();
  });

  it('limits the list to five ordinary items plus a neutral Other cohort at the end', () => {
    const series = [point(1, 1), point(2, 2)];
    const { container } = render(<TrendRanking
      data={[
        { id: 'other', label: 'Weitere', value: 12, isOther: true, series },
        ...Array.from({ length: 7 }, (_, index) => ({ id: `item-${index}`, label: `Produkt ${index + 1}`, value: 20 - index, isOther: false, series })),
      ]}
      summary="Vergangene Buchungen"
      title="Beliebte Produkte"
      valueLabel="Produkte"
    />);

    const rows = [...container.querySelectorAll('ul > li')];
    expect(rows).toHaveLength(6);
    expect(rows[0]).toHaveTextContent('Produkt 1');
    expect(rows[4]).toHaveTextContent('Produkt 5');
    expect(rows[5]).toHaveTextContent('Weitere');
    expect(rows[5]).toHaveTextContent('41');
    expect(rows[5]).toHaveAttribute('data-other', 'true');
    expect(rows[5].querySelector('svg')?.className.baseVal).toContain('rankingSparklineOther');
  });

  it('announces a fully protected series without exposing a false zero', () => {
    const { container } = render(<TrendRanking
      data={[{ id: 'water', label: 'Wasser', value: 7, isOther: false, series: [point(1, null, { privacySuppressed: true })] }]}
      summary="Vergangene Buchungen"
      title="Beliebte Produkte"
      valueLabel="Produkte"
    />);

    expect(screen.getByText('Der Verlauf enthält keine sichtbaren Einzelwerte.')).toHaveClass('sr-only');
    expect(screen.getByText('Geschützte Zeitabschnitte')).toBeVisible();
    expect(container.querySelector('svg')).not.toBeInTheDocument();
  });
});
