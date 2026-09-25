import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ExternalAccountsStatistics, StatisticsMeta } from '@/api/types';
import { ExternalAccountsStatisticsView } from './ExternalAccountsStatisticsView';

const meta: StatisticsMeta = {
  generatedAt: '2026-09-15T12:00:00Z', timezone: 'Europe/Berlin', preset: 'CUSTOM',
  fromInclusive: '2026-08-01T00:00:00Z', toExclusive: '2026-09-01T00:00:00Z',
  bucket: 'DAY', privacyThresholdApplied: false, currentPeriodAvailable: false,
};
const money = (minorUnits: string) => ({ minorUnits, currency: 'EUR' });

describe('external-account statistics', () => {
  it('shows exact balances and switches the single trend using accessible account buttons', async () => {
    const user = userEvent.setup();
    const data: ExternalAccountsStatistics = { currency: 'EUR', accounts: [
      { id: 'bank', name: 'Vereinskonto', type: 'BANK', status: 'ACTIVE', openingBalance: money('10000'), closingBalance: money('12500'), series: [
        { periodStart: '2026-08-01T00:00:00Z', closingBalance: money('10000') },
        { periodStart: '2026-08-02T00:00:00Z', closingBalance: money('12500') },
      ] },
      { id: 'cash', name: 'Barkasse', type: 'CASH', status: 'ARCHIVED', openingBalance: money('0'), closingBalance: money('-500'), series: [
        { periodStart: '2026-08-01T00:00:00Z', closingBalance: money('0') },
        { periodStart: '2026-08-02T00:00:00Z', closingBalance: money('-500') },
      ] },
    ] };
    render(<ExternalAccountsStatisticsView data={data} meta={meta} />);

    const bank = screen.getByRole('button', { name: /Vereinskonto/ });
    const cash = screen.getByRole('button', { name: /Barkasse/ });
    expect(bank).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('figure', { name: 'Vereinskonto' })).toBeVisible();
    expect(screen.getByText(/02\.08\.: 125,00/)).toBeInTheDocument();

    await user.click(cash);
    expect(cash).toHaveAttribute('aria-pressed', 'true');
    expect(bank).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('figure', { name: 'Barkasse' })).toBeVisible();
    expect(screen.getByText(/02\.08\.: -5,00/)).toBeInTheDocument();
  });

  it('shows a neutral empty state', () => {
    render(<ExternalAccountsStatisticsView data={{ currency: 'EUR', accounts: [] }} meta={meta} />);
    expect(screen.getByText('Noch keine externen Konten vorhanden.')).toBeVisible();
  });
});
