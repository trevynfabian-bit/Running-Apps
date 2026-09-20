/**
 * Comparing two composition sessions.
 *
 * The question this answers is "what changed between these two", and the
 * honest answer has three shapes, not one:
 *
 *   Both sessions measured a point — there is a change, and it is a number.
 *   Only one measured it — there is a value but no change, and saying
 *     "no change" would be a claim the data does not support.
 *   Neither measured it — the point simply is not part of this comparison.
 *
 * Collapsing the middle case into a zero is the mistake worth designing
 * against: an athlete who skipped their thigh in June would read "0.0 cm" in
 * September as three months of nothing happening.
 *
 * Pure and side-effect free; the arithmetic comes from `@running/core` so the
 * deltas here and the deltas in the history list are the same number.
 */

import { netChangeCm, type LengthUnit } from '@running/core';

import { STUB_CIRCUMFERENCE_POINTS, type CircumferencePoint } from './body-composition';
import { measurementForPoint, type BodyCompositionSession } from './composition-session';

export interface ComparisonRow {
  point: CircumferencePoint;
  /** Value in the earlier session, canonical centimetres. */
  fromCm?: number;
  /** Value in the later session, canonical centimetres. */
  toCm?: number;
  /** Present only when both sessions measured this point. */
  changeCm?: number;
  /** The unit the later reading was taken in, for honest re-display. */
  recordedUnit?: LengthUnit;
}

export interface SessionComparison {
  earlier: BodyCompositionSession;
  later: BodyCompositionSession;
  /** One row per measure point, in anatomical order. */
  rows: readonly ComparisonRow[];
  /** Points where both sessions have a value. */
  comparableCount: number;
  /** Days between the two sessions. */
  daysApart: number;
}

/**
 * Put two sessions in time order.
 *
 * The caller picks two sessions from a list; which one they tapped first says
 * nothing about which came first. Ordering here means every reader downstream
 * gets "earlier" and "later" meaning what they say.
 */
export function orderSessions(
  a: BodyCompositionSession,
  b: BodyCompositionSession,
): { earlier: BodyCompositionSession; later: BodyCompositionSession } {
  return Date.parse(a.capturedAt) <= Date.parse(b.capturedAt)
    ? { earlier: a, later: b }
    : { earlier: b, later: a };
}

/** Whole days between two sessions, rounded down, never negative. */
export function daysBetween(a: string, b: string): number {
  const millis = Math.abs(Date.parse(b) - Date.parse(a));
  if (!Number.isFinite(millis)) return 0;
  return Math.floor(millis / 86_400_000);
}

export function compareSessions(
  a: BodyCompositionSession,
  b: BodyCompositionSession,
  points: readonly CircumferencePoint[] = STUB_CIRCUMFERENCE_POINTS,
): SessionComparison {
  const { earlier, later } = orderSessions(a, b);

  const rows: ComparisonRow[] = [...points]
    .sort((first, second) => first.sortOrder - second.sortOrder)
    .map((point) => {
      const from = measurementForPoint(earlier, point.id);
      const to = measurementForPoint(later, point.id);

      return {
        point,
        ...(from ? { fromCm: from.valueCm } : {}),
        ...(to ? { toCm: to.valueCm, recordedUnit: to.recordedUnit } : {}),
        // Only when both sides exist. A missing side is not a zero change.
        ...(from && to ? { changeCm: to.valueCm - from.valueCm } : {}),
      };
    });

  return {
    earlier,
    later,
    rows,
    comparableCount: rows.filter((row) => row.changeCm !== undefined).length,
    daysApart: daysBetween(earlier.capturedAt, later.capturedAt),
  };
}

/** Rows the comparison can actually speak to, for a summary line. */
export function comparableRows(comparison: SessionComparison): ComparisonRow[] {
  return comparison.rows.filter((row) => row.changeCm !== undefined);
}

/**
 * Net change across every comparable point.
 *
 * Undefined when nothing is comparable — a comparison of two sessions that
 * share no measure point has no total, and reporting zero would suggest it
 * found nothing rather than that it could not look.
 */
export function totalChangeCm(comparison: SessionComparison): number | undefined {
  const rows = comparableRows(comparison);
  if (rows.length === 0) return undefined;
  return rows.reduce((sum, row) => sum + (row.changeCm ?? 0), 0);
}

/**
 * Net change for one point across a whole run of sessions.
 *
 * Delegates the arithmetic to core so a trend read here and a trend read in
 * the history list cannot disagree.
 */
export function netChangeForPoint(
  sessions: readonly BodyCompositionSession[],
  pointId: string,
): number | undefined {
  const readings = sessions.flatMap((session) => {
    const measurement = measurementForPoint(session, pointId);
    return measurement ? [{ capturedAt: session.capturedAt, valueCm: measurement.valueCm }] : [];
  });

  return netChangeCm(readings);
}
