/**
 * Longitudinal trend analysis.
 *
 * Separates three things the UI must never conflate:
 *   the raw metric      — what it is right now
 *   the trend           — which way it is moving, and how fast
 *   the confidence      — whether we should believe the trend at all
 *
 * The confidence model is the important part. With sparse or noisy data the
 * honest answer is "we can't tell yet", and saying so is more useful than a
 * plausible-looking arrow.
 */

import type { ConfidenceLevel } from '../domain/provenance.js';
import { linearRegression, mean, percentChange, round, stdDev } from '../util/stats.js';
import { daysBetweenLocalDates } from '../util/time.js';

export type TrendDirection = 'improving' | 'stable' | 'declining' | 'insufficient_data';

/** For some metrics a falling number is an improvement (pace, resting HR). */
export type MetricPolarity = 'higher_is_better' | 'lower_is_better';

export interface TrendPoint {
  /** Local date `YYYY-MM-DD`. */
  date: string;
  value: number;
}

export interface Trend {
  metric: string;
  /** Most recent observed value. */
  current?: number;
  /** Value at the start of the window (fitted, not raw, to reduce noise). */
  baseline?: number;
  /** Absolute change across the window, in the metric's own units. */
  absoluteChange?: number;
  percentChange?: number;
  direction: TrendDirection;
  confidence: ConfidenceLevel;
  sampleCount: number;
  windowDays: number;
  r2?: number;
  /** Athlete-facing sentence. */
  summary: string;
}

export interface TrendOptions {
  metric: string;
  polarity: MetricPolarity;
  /** Minimum points before a direction is claimed at all. */
  minSamples?: number;
  /**
   * Relative change below which the metric counts as stable. Defaults to 3%;
   * pass a larger value for noisy metrics like day-to-day HRV.
   */
  stableThresholdPercent?: number;
  /** Human-readable unit for the summary sentence. */
  unitLabel?: string;
  /** Format a value for display. Defaults to one decimal place. */
  format?: (value: number) => string;
}

export function computeTrend(points: readonly TrendPoint[], options: TrendOptions): Trend {
  const minSamples = options.minSamples ?? 4;
  const stableThreshold = options.stableThresholdPercent ?? 3;
  const format = options.format ?? ((v: number): string => v.toFixed(1));

  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));

  if (sorted.length < minSamples) {
    return {
      metric: options.metric,
      current: sorted[sorted.length - 1]?.value,
      direction: 'insufficient_data',
      confidence: 'low',
      sampleCount: sorted.length,
      windowDays: 0,
      summary: `Not enough data yet to identify a trend in ${options.metric.toLowerCase()}. ${
        minSamples - sorted.length
      } more data point(s) needed.`,
    };
  }

  const origin = sorted[0]!.date;
  const regressionPoints = sorted.map((p) => ({
    x: daysBetweenLocalDates(origin, p.date),
    y: p.value,
  }));

  const regression = linearRegression(regressionPoints);
  const windowDays = daysBetweenLocalDates(origin, sorted[sorted.length - 1]!.date);
  const current = sorted[sorted.length - 1]!.value;

  if (!regression || windowDays <= 0) {
    return {
      metric: options.metric,
      current,
      direction: 'insufficient_data',
      confidence: 'low',
      sampleCount: sorted.length,
      windowDays: Math.max(0, windowDays),
      summary: `${options.metric} could not be trended over this window.`,
    };
  }

  // Use fitted endpoints rather than raw first/last values: a single unusual
  // session at either end shouldn't define the trend.
  const baseline = regression.intercept;
  const fittedCurrent = regression.intercept + regression.slope * windowDays;
  const absoluteChange = fittedCurrent - baseline;
  const relativeChange = percentChange(baseline, fittedCurrent) ?? 0;

  const improved =
    options.polarity === 'higher_is_better' ? absoluteChange > 0 : absoluteChange < 0;

  const direction: TrendDirection =
    Math.abs(relativeChange) < stableThreshold ? 'stable' : improved ? 'improving' : 'declining';

  const confidence = trendConfidence(sorted, regression.r2, windowDays);

  return {
    metric: options.metric,
    current,
    baseline,
    absoluteChange,
    percentChange: round(relativeChange, 1),
    direction,
    confidence,
    sampleCount: sorted.length,
    windowDays,
    r2: round(regression.r2, 3),
    summary: summarizeTrend({
      metric: options.metric,
      direction,
      confidence,
      absoluteChange,
      relativeChange,
      windowDays,
      unitLabel: options.unitLabel,
      format,
    }),
  };
}

/**
 * Confidence in a trend, from sample density, fit quality and window length.
 *
 * A steep slope through scattered points is not evidence; a shallow slope
 * through tight points often is. r² therefore matters more than magnitude.
 */
function trendConfidence(
  points: readonly TrendPoint[],
  r2: number,
  windowDays: number,
): ConfidenceLevel {
  const density = windowDays > 0 ? points.length / (windowDays / 7) : 0; // points per week

  // Noise check: a series whose deviation dwarfs its mean can't support a claim.
  const values = points.map((p) => p.value);
  const m = mean(values) ?? 0;
  const sd = stdDev(values) ?? 0;
  const noise = m === 0 ? 1 : sd / Math.abs(m);

  if (points.length >= 8 && r2 >= 0.5 && windowDays >= 21 && noise < 0.25) return 'high';
  if (points.length >= 5 && (r2 >= 0.3 || density >= 1.5) && windowDays >= 14) return 'moderate';
  return 'low';
}

function summarizeTrend(args: {
  metric: string;
  direction: TrendDirection;
  confidence: ConfidenceLevel;
  absoluteChange: number;
  relativeChange: number;
  windowDays: number;
  unitLabel?: string;
  format: (value: number) => string;
}): string {
  const { metric, direction, confidence, absoluteChange, windowDays, unitLabel, format } = args;
  const weeks = Math.max(1, Math.round(windowDays / 7));
  const magnitude = format(Math.abs(absoluteChange));
  const unit = unitLabel ? ` ${unitLabel}` : '';

  const hedge =
    confidence === 'low'
      ? ' The data is noisy, so treat this as provisional.'
      : confidence === 'moderate'
        ? ''
        : '';

  switch (direction) {
    case 'improving':
      return `${metric} has improved by ${magnitude}${unit} over ${weeks} week${weeks === 1 ? '' : 's'}.${hedge}`;
    case 'declining':
      return `${metric} has moved ${magnitude}${unit} in the wrong direction over ${weeks} week${weeks === 1 ? '' : 's'}.${hedge}`;
    case 'stable':
      return `${metric} has been stable over the last ${weeks} week${weeks === 1 ? '' : 's'}.${hedge}`;
    case 'insufficient_data':
      return `Not enough data to trend ${metric.toLowerCase()}.`;
  }
}

/** Aggregate a daily series into weekly totals, keyed by week start. */
export function weeklyTotals(
  points: readonly TrendPoint[],
  weekStartFor: (date: string) => string,
): TrendPoint[] {
  const byWeek = new Map<string, number>();
  for (const point of points) {
    const week = weekStartFor(point.date);
    byWeek.set(week, (byWeek.get(week) ?? 0) + point.value);
  }
  return [...byWeek.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Restrict a series to the trailing N days relative to a reference date. */
export function windowed(
  points: readonly TrendPoint[],
  referenceDate: string,
  days: number,
): TrendPoint[] {
  return points.filter((p) => {
    const age = daysBetweenLocalDates(p.date, referenceDate);
    return age >= 0 && age <= days;
  });
}

/** Standard comparison windows offered in the Progress screen. */
export const TREND_WINDOWS = [
  { label: '4 weeks', days: 28 },
  { label: '8 weeks', days: 56 },
  { label: '12 weeks', days: 84 },
] as const;
