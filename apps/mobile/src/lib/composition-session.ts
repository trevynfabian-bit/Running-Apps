/**
 * A body composition session, and the rules for putting measurements in it.
 *
 * A session is one documentation moment: the athlete stands in front of the
 * same spot, takes their four photos, runs the tape round each point, and that
 * whole set is what a later session gets compared against.
 *
 * That framing decides the one rule worth stating: **a session holds at most
 * one value per measure point.** Re-measuring the waist because the tape
 * slipped replaces the earlier number rather than appending a second one. Two
 * waist values in a single session would leave every downstream reader — the
 * comparison view, the body-fat formula — having to guess which one the athlete
 * meant, and the honest answer is always "the one they took last".
 *
 * Pure and side-effect free, in the style of `@running/core`: ids and
 * timestamps are passed in rather than read from the environment, so the same
 * inputs always produce the same session and tests need no clock.
 */

import type { BodyMeasurement, CircumferencePoint } from './body-composition';

export interface BodyCompositionSession {
  id: string;
  /** When the session was started. ISO-8601. */
  capturedAt: string;
  /** At most one entry per `pointId`, most recently recorded first. */
  measurements: readonly BodyMeasurement[];
}

export function createSession(id: string, capturedAt: string): BodyCompositionSession {
  return { id, capturedAt, measurements: [] };
}

/**
 * Record a measurement, replacing any earlier value for the same point.
 *
 * The new value goes to the front: the list reads newest-first, matching the
 * history ordering used elsewhere in the app, and the thing the athlete just
 * typed is the thing they want to see confirmed.
 */
export function addMeasurement(
  session: BodyCompositionSession,
  measurement: BodyMeasurement,
): BodyCompositionSession {
  return {
    ...session,
    measurements: [
      measurement,
      ...session.measurements.filter((existing) => existing.pointId !== measurement.pointId),
    ],
  };
}

/** Remove a point's measurement from the session, if it has one. */
export function removeMeasurement(
  session: BodyCompositionSession,
  pointId: string,
): BodyCompositionSession {
  const measurements = session.measurements.filter((existing) => existing.pointId !== pointId);
  if (measurements.length === session.measurements.length) return session;
  return { ...session, measurements };
}

/** The value recorded for a point in this session, if any. */
export function measurementForPoint(
  session: BodyCompositionSession,
  pointId: string,
): BodyMeasurement | undefined {
  return session.measurements.find((existing) => existing.pointId === pointId);
}

/** Points already covered, for marking them off in the picker. */
export function measuredPointIds(session: BodyCompositionSession): readonly string[] {
  return session.measurements.map((measurement) => measurement.pointId);
}

/** A session with nothing in it yet is not worth saving or comparing. */
export function isSessionEmpty(session: BodyCompositionSession): boolean {
  return session.measurements.length === 0;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface SessionSummaryRow {
  point: CircumferencePoint;
  /** Undefined when this point has not been measured in the session. */
  measurement?: BodyMeasurement;
}

export interface SessionSummary {
  /** One row per measure point, in anatomical order, measured or not. */
  rows: readonly SessionSummaryRow[];
  measuredCount: number;
  totalPoints: number;
  /** True once every point carries a value. */
  isComplete: boolean;
}

/**
 * Build the session's summary: every point, in order, with or without a value.
 *
 * Deliberately not "the list of what was saved". The recording list is
 * newest-first, which is right for confirming the number just typed, but it
 * makes a poor summary — the rows move around as the athlete works, and a point
 * that was never measured is invisible precisely when they need to notice it.
 *
 * The summary is the opposite: a fixed set of rows in the order the athlete
 * works down their body, where a gap reads as a gap.
 *
 * Ordering comes from each point's `sortOrder` rather than the order they were
 * passed in, so a caller that filters or re-groups the point list cannot
 * accidentally shuffle the summary.
 */
export function summariseSession(
  session: BodyCompositionSession | undefined,
  points: readonly CircumferencePoint[],
): SessionSummary {
  const rows = [...points]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((point) => {
      const measurement = session ? measurementForPoint(session, point.id) : undefined;
      return measurement ? { point, measurement } : { point };
    });

  const measuredCount = rows.filter((row) => row.measurement !== undefined).length;

  return {
    rows,
    measuredCount,
    totalPoints: rows.length,
    // An empty point list is not a complete session — it is a caller passing
    // nothing, and reporting "complete" for it would be a lie.
    isComplete: rows.length > 0 && measuredCount === rows.length,
  };
}
