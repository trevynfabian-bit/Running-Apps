/**
 * One measure point's values over time.
 *
 * A session answers "where am I today"; the history answers "which way is this
 * going", which is the question an athlete actually has when they put a tape
 * round their waist for the fourth month running.
 *
 * Two decisions shape the output:
 *
 *   Newest first, matching every other history list in the app.
 *
 *   Each entry carries the change from the one before it. A column of numbers
 *   with no deltas makes the reader do arithmetic to find the only thing they
 *   came for, and doing it in their head across a unit switch is where mistakes
 *   come from. The change is computed in centimetres — the canonical unit — so
 *   it is the same number regardless of how either session was typed in.
 *
 * Pure and side-effect free. Sessions are passed in, including the in-progress
 * one when it has a value, so a measurement just saved appears at the top of
 * the list immediately.
 */

import type { LengthUnit } from '@running/core';

import { measurementForPoint, type BodyCompositionSession } from './composition-session';

export interface MetricHistoryEntry {
  sessionId: string;
  /** When the session it belongs to was taken. ISO-8601. */
  capturedAt: string;
  valueCm: number;
  /** The unit the athlete read off the tape for this one. */
  recordedUnit: LengthUnit;
  /**
   * Change in centimetres from the next-older session that measured this
   * point. Undefined on the oldest entry, which has nothing to compare to —
   * distinct from a change of exactly zero.
   */
  changeCm?: number;
}

/**
 * Build a point's history from a set of sessions.
 *
 * Sessions without a value for the point drop out entirely rather than
 * appearing as gaps: skipping the neck for two months does not mean the neck
 * measured nothing, and a run of blank rows would imply it did.
 */
export function historyForPoint(
  sessions: readonly BodyCompositionSession[],
  pointId: string,
): readonly MetricHistoryEntry[] {
  const measured = sessions
    .map((session) => ({ session, measurement: measurementForPoint(session, pointId) }))
    .filter(
      (
        candidate,
      ): candidate is {
        session: BodyCompositionSession;
        measurement: NonNullable<typeof candidate.measurement>;
      } => candidate.measurement !== undefined,
    )
    // Sort here rather than trusting the caller: the in-progress session is
    // prepended by the screen, and a stub list is easy to leave unordered.
    .sort((a, b) => Date.parse(b.session.capturedAt) - Date.parse(a.session.capturedAt));

  return measured.map((entry, index) => {
    // The array is newest-first, so the *older* neighbour is the next index.
    const older = measured[index + 1];

    return {
      sessionId: entry.session.id,
      capturedAt: entry.session.capturedAt,
      valueCm: entry.measurement.valueCm,
      recordedUnit: entry.measurement.recordedUnit,
      ...(older ? { changeCm: entry.measurement.valueCm - older.measurement.valueCm } : {}),
    };
  });
}

/** The most recent value recorded for a point, across every session given. */
export function latestForPoint(
  sessions: readonly BodyCompositionSession[],
  pointId: string,
): MetricHistoryEntry | undefined {
  return historyForPoint(sessions, pointId)[0];
}
