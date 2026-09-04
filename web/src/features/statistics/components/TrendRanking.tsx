import { useTranslation } from 'react-i18next';
import type { MemberStatisticsBreakdownPoint } from '@/api/types';
import { formatStatisticsInteger } from '../statisticsFormat';
import { ChartFrame } from './ChartFrame';
import styles from './StatisticsCharts.module.css';

const maximumRegularItems = 5;
const maximumSeriesPoints = 60;

/** One item accepted by the reusable purchasing trend list. */
export interface TrendRankingDatum {
  id: string;
  label: string;
  context?: string;
  value: number;
  series: readonly MemberStatisticsBreakdownPoint[];
  isOther: boolean;
}

/** Properties accepted by the purchasing trend list. */
export interface TrendRankingProps {
  title: string;
  summary: string;
  valueLabel: string;
  data: readonly TrendRankingDatum[];
}

interface SparklineCoordinate {
  x: number;
  y: number;
  point: MemberStatisticsBreakdownPoint;
}

/** Combines visible overflow items into the single simplified "Other" row. */
function combineOtherItems(items: readonly TrendRankingDatum[], label: string): TrendRankingDatum | undefined {
  if (items.length === 0) return undefined;
  const seriesLength = Math.max(0, ...items.map((item) => item.series.length));
  const series = Array.from({ length: seriesLength }, (_, index): MemberStatisticsBreakdownPoint => {
    const points = items.flatMap((item) => item.series[index] ? [item.series[index]] : []);
    const privacySuppressed = points.some((point) => point.privacySuppressed);
    const unavailable = points.length !== items.length || points.some((point) => point.validBookedUnits === null);
    return {
      periodStart: points[0]?.periodStart ?? '',
      validBookedUnits: privacySuppressed || unavailable
        ? null
        : points.reduce((sum, point) => sum + (point.validBookedUnits ?? 0), 0),
      privacySuppressed,
      isPartial: points.some((point) => point.isPartial),
    };
  });
  return {
    id: 'simplified-other',
    label,
    value: items.reduce((sum, item) => sum + item.value, 0),
    series,
    isOther: true,
  };
}

/** Renders a small SVG trend with explicit protected gaps and running segments. */
function RankingSparkline({ isOther, series }: { isOther: boolean; series: readonly MemberStatisticsBreakdownPoint[] }) {
  const width = 140;
  const height = 32;
  const padding = 3;
  const numericValues = series.flatMap((point) => point.validBookedUnits === null || point.privacySuppressed ? [] : [point.validBookedUnits]);
  if (series.length === 0 || numericValues.length === 0) return null;
  const minimum = Math.min(...numericValues);
  const maximum = Math.max(...numericValues);
  const span = maximum - minimum;
  const coordinates: Array<SparklineCoordinate | null> = series.map((point, index) => point.validBookedUnits === null || point.privacySuppressed ? null : ({
    x: series.length === 1 ? width / 2 : (index / (series.length - 1)) * width,
    y: span === 0 ? height / 2 : padding + (((maximum - point.validBookedUnits) / span) * (height - (padding * 2))),
    point,
  }));
  const segments = coordinates.slice(1).flatMap((current, index) => {
    const previous = coordinates[index];
    return previous && current ? [{ previous, current, partial: previous.point.isPartial || current.point.isPartial }] : [];
  });

  return (
    <svg aria-hidden="true" className={`${styles.rankingSparkline} ${isOther ? styles.rankingSparklineOther : ''}`} focusable="false" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
      {series.map((point, index) => point.privacySuppressed ? (
        <line className={styles.rankingProtectedMark} key={`protected-${point.periodStart}`} x1={series.length === 1 ? width / 2 : (index / (series.length - 1)) * width} x2={series.length === 1 ? width / 2 : (index / (series.length - 1)) * width} y1={padding} y2={height - padding} />
      ) : null)}
      {segments.map((segment) => (
        <line
          className={segment.partial ? styles.rankingPartialSegment : styles.rankingTrendSegment}
          key={`${segment.previous.point.periodStart}-${segment.current.point.periodStart}`}
          x1={segment.previous.x}
          x2={segment.current.x}
          y1={segment.previous.y}
          y2={segment.current.y}
        />
      ))}
      {coordinates.map((coordinate) => coordinate ? (
        <circle
          className={coordinate.point.isPartial ? styles.rankingPartialPoint : styles.rankingTrendPoint}
          cx={coordinate.x}
          cy={coordinate.y}
          key={`point-${coordinate.point.periodStart}`}
          r={coordinate.point.isPartial ? 2.5 : 1.25}
        />
      ) : null)}
    </svg>
  );
}

/**
 * Renders a simple purchasing list with names, proportional bars, totals, and microtrends.
 *
 * @param props - Items and their privacy-aware trends plus visible labels.
 * @returns A bounded responsive list with every important value visible without hover.
 */
export function TrendRanking({ title, summary, valueLabel, data }: TrendRankingProps) {
  const { t } = useTranslation();
  const regularItems = data.filter((item) => !item.isOther);
  const otherItems = [
    ...regularItems.slice(maximumRegularItems),
    ...data.filter((item) => item.isOther),
  ];
  const other = combineOtherItems(otherItems, t('statistics.other'));
  const visibleData = [
    ...regularItems.slice(0, maximumRegularItems),
    ...(other ? [other] : []),
  ].map((item) => ({ ...item, series: item.series.slice(0, maximumSeriesPoints) }));
  const maximumValue = Math.max(1, ...visibleData.map((item) => item.value));

  return (
    <ChartFrame className={styles.trendRankingFrame} summary={summary} title={title}>
      <ul className={styles.trendRankingList}>
        {visibleData.map((item) => {
          const hasProtected = item.series.some((point) => point.privacySuppressed);
          const hasPartial = item.series.some((point) => point.isPartial);
          const visibleValues = item.series.flatMap((point) => point.validBookedUnits === null || point.privacySuppressed ? [] : [point.validBookedUnits]);
          const firstValue = visibleValues[0];
          const lastValue = visibleValues.at(-1);
          return (
            <li className={styles.trendRankingRow} data-other={item.isOther} key={item.id}>
              <span className={styles.trendName}>
                <strong>{item.label}</strong>
                {item.context ? <small>{item.context}</small> : null}
              </span>
              <span aria-hidden="true" className={styles.trendBar}><span style={{ width: `${(item.value / maximumValue) * 100}%` }} /></span>
              <span className={styles.trendMicro}>
                <RankingSparkline isOther={item.isOther} series={item.series} />
                <span className="sr-only">{firstValue === undefined || lastValue === undefined
                  ? t('statistics.ranking.noVisibleTrend')
                  : t('statistics.ranking.seriesSummary', { count: item.series.length, first: formatStatisticsInteger(firstValue), last: formatStatisticsInteger(lastValue) })}</span>
                {hasProtected || hasPartial ? (
                  <small>{hasProtected ? t('statistics.ranking.containsProtected') : null}{hasProtected && hasPartial ? ' · ' : null}{hasPartial ? t('statistics.ranking.containsPartial') : null}</small>
                ) : null}
              </span>
              <span className={styles.trendTotal}>
                <strong>{formatStatisticsInteger(item.value)}</strong>
                <small>{valueLabel}</small>
              </span>
            </li>
          );
        })}
      </ul>
    </ChartFrame>
  );
}
