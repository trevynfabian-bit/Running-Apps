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

import type { BodyMeasurement } from './body-composition';

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
