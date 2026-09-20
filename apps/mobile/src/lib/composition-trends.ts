/**
 * Series for the trend chart.
 *
 * One metric at a time, deliberately. Circumference is centimetres, weight is
 * kilograms and body fat is a percentage: putting any two of them on one plot
 * needs two y-scales, and the alignment between two scales is arbitrary, so the
 * chart would invent a correlation that is not in the data. The metric picker
 * is not a convenience — it is what keeps the chart honest.
 *
 * Body fat comes back as a band rather than a line for the same reason it is
 * shown as a band everywhere else: the method's error is wide enough that a
 * single trace would imply precision the estimate does not have.
 */

import { STUB_CIRCUMFERENCE_POINTS, type CircumferencePoint } from './body-composition';
import { measurementForPoint, type BodyCompositionSession } from './composition-session';
import { sessionsInRange } from './composition-compare';

export type TrendMetric =
  { kind: 'circumference'; pointId: string } | { kind: 'weight' } | { kind: 'bodyFat' };

export interface TrendPoint {
  capturedAt: string;
  value: number;
}

export interface TrendBandPoint {
  capturedAt: string;
  low: number;
  high: number;
}

export interface TrendSeries {
  /** What is being charted, for the title. A single series needs no legend. */
  label: string;
  /** Unit suffix for the axis and the read-out. */
  unit: string;
  /** Present for a line metric. */
  points?: readonly TrendPoint[];
  /** Present for body fat, which is a band and not a line. */
  band?: readonly TrendBandPoint[];
}

/**
 * A dated value, as the app's existing sources hand them back.
 *
 * Weight already exists in the progress endpoint's `body.weightKilograms`, and
 * body fat in the `body_fat_estimates` rows the API keeps per session. Neither
 * is wired up yet, so both arrive here as fixtures — but the shape is the one
 * those sources produce, so connecting them is a change of caller.
 */
export interface DatedValue {
  capturedAt: string;
  value: number;
}

export interface DatedBand {
  capturedAt: string;
  low: number;
  high: number;
}

export interface TrendSources {
  sessions: readonly BodyCompositionSession[];
  weightKg: readonly DatedValue[];
  bodyFatPercent: readonly DatedBand[];
  points?: readonly CircumferencePoint[];
}

const byDateAscending = <T extends { capturedAt: string }>(a: T, b: T): number =>
  Date.parse(a.capturedAt) - Date.parse(b.capturedAt);

/** Keep only what falls inside the window, oldest first for plotting. */
function within<T extends { capturedAt: string }>(
  values: readonly T[],
  days: number | undefined,
  now: Date,
): T[] {
  const cutoff = days === undefined ? -Infinity : now.getTime() - days * 86_400_000;
  return values.filter((value) => Date.parse(value.capturedAt) >= cutoff).sort(byDateAscending);
}

/**
 * Build the series for one metric over one window.
 *
 * Returns undefined for a metric with no data at all, so the caller can say
 * "nothing recorded" rather than render an empty axis — an empty chart looks
 * like a loading state or a bug, and it is neither.
 */
export function buildTrendSeries(
  sources: TrendSources,
  metric: TrendMetric,
  days: number | undefined,
  now: Date = new Date(),
): TrendSeries | undefined {
  if (metric.kind === 'weight') {
    const points = within(sources.weightKg, days, now);
    if (points.length === 0) return undefined;
    return { label: 'Weight', unit: 'kg', points };
  }

  if (metric.kind === 'bodyFat') {
    const band = within(sources.bodyFatPercent, days, now);
    if (band.length === 0) return undefined;
    return { label: 'Body fat estimate', unit: '%', band };
  }

  const point = (sources.points ?? STUB_CIRCUMFERENCE_POINTS).find(
    (candidate) => candidate.id === metric.pointId,
  );
  if (!point) return undefined;

  const inRange = sessionsInRange(sources.sessions, days, now);
  const points = inRange
    .flatMap((session) => {
      const measurement = measurementForPoint(session, point.id);
      return measurement ? [{ capturedAt: session.capturedAt, value: measurement.valueCm }] : [];
    })
    .sort(byDateAscending);

  if (points.length === 0) return undefined;
  return { label: point.label, unit: 'cm', points };
}

/**
 * The vertical extent to plot against, with a little headroom.
 *
 * A flat series would collapse to a zero-height range and divide by zero, so it
 * gets a nominal band and draws as a straight line through the middle — which
 * is the truthful picture of a value that has not moved.
 *
 * The axis deliberately does not start at zero. These are circumferences and
 * body weights, where zero is not a meaningful baseline and anchoring to it
 * would flatten every real change into invisibility.
 */
export function trendExtent(series: TrendSeries): { min: number; max: number } {
  const values = series.band
    ? series.band.flatMap((entry) => [entry.low, entry.high])
    : (series.points ?? []).map((entry) => entry.value);

  if (values.length === 0) return { min: 0, max: 1 };

  const low = Math.min(...values);
  const high = Math.max(...values);

  if (high === low) {
    const nominal = Math.max(Math.abs(low) * 0.02, 0.5);
    return { min: low - nominal, max: high + nominal };
  }

  const padding = (high - low) * 0.12;
  return { min: low - padding, max: high + padding };
}

/** How many readings the series holds — a chart needs at least two. */
export function trendLength(series: TrendSeries): number {
  return series.band?.length ?? series.points?.length ?? 0;
}
