import type { Money, StatisticsBucket } from '@/api/types';
import { formatMoney } from '@/api/money';

const integerFormatter = new Intl.NumberFormat('de-DE');

/** Formats an integer count using the application locale. */
export function formatStatisticsInteger(value: number): string {
  return integerFormatter.format(value);
}

/** BigInt-safe coordinate scale shared by all values in one money chart. */
export interface MoneyChartScale {
  divisor: bigint;
  coordinate: (value: Money) => number;
  formatTick: (coordinate: number, currency: string) => string;
}

/**
 * Creates a common integer divisor that keeps every SVG coordinate safe.
 * Exact values are never reconstructed from coordinates; visible endpoint
 * labels and assistive summaries retain their original minor-unit strings.
 *
 * @param values - Exact values plotted together in one chart.
 * @returns A scale whose quotient is always a safe JavaScript number.
 */
export function createMoneyChartScale(values: readonly Money[]): MoneyChartScale {
  const safeMaximum = BigInt(Number.MAX_SAFE_INTEGER);
  let maximum = 0n;
  values.forEach((value) => {
    const raw = BigInt(value.minorUnits);
    const absolute = raw < 0n ? -raw : raw;
    if (absolute > maximum) maximum = absolute;
  });
  const divisor = maximum > safeMaximum ? ((maximum - 1n) / safeMaximum) + 1n : 1n;
  return {
    divisor,
    coordinate: (value) => {
      const raw = BigInt(value.minorUnits);
      const quotient = raw / divisor;
      const remainder = raw % divisor;
      return Number(quotient) + (Number(remainder) / Number(divisor));
    },
    formatTick: (coordinate, currency) => {
      const raw = BigInt(Math.round(coordinate)) * divisor;
      return formatMoney({ minorUnits: raw.toString(), currency });
    },
  };
}

/** Formats one server-selected bucket start in the projection timezone. */
export function formatStatisticsPeriod(periodStart: string, bucket: StatisticsBucket, timezone: string): string {
  const options: Intl.DateTimeFormatOptions = bucket === 'YEAR'
    ? { year: 'numeric', timeZone: timezone }
    : bucket === 'MONTH'
    ? { month: 'short', year: '2-digit', timeZone: timezone }
    : { day: '2-digit', month: '2-digit', timeZone: timezone };
  return new Intl.DateTimeFormat('de-DE', options).format(new Date(periodStart));
}

/** Formats exact money while retaining the supplied canonical currency. */
export function formatStatisticsMoney(value: Money): string {
  return formatMoney(value);
}
