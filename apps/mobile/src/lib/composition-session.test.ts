/**
 * The rule under test: a session holds at most one value per measure point,
 * and re-measuring replaces rather than appends.
 */

import { describe, expect, it } from 'vitest';

import type { BodyMeasurement, CircumferencePoint } from './body-composition';
import {
  addMeasurement,
  createSession,
  isSessionEmpty,
  measuredPointIds,
  measurementForPoint,
  removeMeasurement,
  summariseSession,
} from './composition-session';

const STARTED_AT = '2026-09-20T08:00:00.000Z';

function measurement(overrides: Partial<BodyMeasurement> = {}): BodyMeasurement {
  return {
    id: 'm-1',
    pointId: 'point-waist',
    valueCm: 86.4,
    recordedUnit: 'cm',
    capturedAt: STARTED_AT,
    ...overrides,
  };
}

describe('body composition session', () => {
  it('starts empty and stamped with when it began', () => {
    const session = createSession('session-1', STARTED_AT);

    expect(session.id).toBe('session-1');
    expect(session.capturedAt).toBe(STARTED_AT);
    expect(session.measurements).toEqual([]);
    expect(isSessionEmpty(session)).toBe(true);
  });

  it('holds a recorded measurement, newest first', () => {
    let session = createSession('session-1', STARTED_AT);
    session = addMeasurement(session, measurement({ id: 'm-1', pointId: 'point-waist' }));
    session = addMeasurement(session, measurement({ id: 'm-2', pointId: 'point-chest' }));

    expect(session.measurements.map((m) => m.id)).toEqual(['m-2', 'm-1']);
    expect(isSessionEmpty(session)).toBe(false);
  });

  it('replaces rather than appends when a point is measured again', () => {
    let session = createSession('session-1', STARTED_AT);
    session = addMeasurement(session, measurement({ id: 'm-1', valueCm: 86.4 }));
    session = addMeasurement(session, measurement({ id: 'm-2', valueCm: 85.1 }));

    // One waist value, and it is the one taken last.
    expect(session.measurements).toHaveLength(1);
    expect(measurementForPoint(session, 'point-waist')?.valueCm).toBe(85.1);
    expect(measurementForPoint(session, 'point-waist')?.id).toBe('m-2');
  });

  it('replaces only the point being re-measured', () => {
    let session = createSession('session-1', STARTED_AT);
    session = addMeasurement(session, measurement({ id: 'm-1', pointId: 'point-waist' }));
    session = addMeasurement(session, measurement({ id: 'm-2', pointId: 'point-chest' }));
    session = addMeasurement(
      session,
      measurement({ id: 'm-3', pointId: 'point-waist', valueCm: 85.1 }),
    );

    expect(session.measurements).toHaveLength(2);
    expect(measurementForPoint(session, 'point-waist')?.id).toBe('m-3');
    expect(measurementForPoint(session, 'point-chest')?.id).toBe('m-2');
  });

  it('keeps the unit the replacement was measured in', () => {
    let session = createSession('session-1', STARTED_AT);
    session = addMeasurement(session, measurement({ recordedUnit: 'cm' }));
    session = addMeasurement(
      session,
      measurement({ id: 'm-2', valueCm: 86.36, recordedUnit: 'in' }),
    );

    expect(measurementForPoint(session, 'point-waist')?.recordedUnit).toBe('in');
  });

  it('reports which points are covered', () => {
    let session = createSession('session-1', STARTED_AT);
    session = addMeasurement(session, measurement({ id: 'm-1', pointId: 'point-waist' }));
    session = addMeasurement(session, measurement({ id: 'm-2', pointId: 'point-chest' }));

    expect([...measuredPointIds(session)].sort()).toEqual(['point-chest', 'point-waist']);
    expect(measurementForPoint(session, 'point-thigh')).toBeUndefined();
  });

  it('removes one point and leaves the rest alone', () => {
    let session = createSession('session-1', STARTED_AT);
    session = addMeasurement(session, measurement({ id: 'm-1', pointId: 'point-waist' }));
    session = addMeasurement(session, measurement({ id: 'm-2', pointId: 'point-chest' }));

    session = removeMeasurement(session, 'point-waist');

    expect(measurementForPoint(session, 'point-waist')).toBeUndefined();
    expect(measurementForPoint(session, 'point-chest')?.id).toBe('m-2');
  });

  it('treats removing an unmeasured point as a no-op', () => {
    const session = addMeasurement(createSession('session-1', STARTED_AT), measurement());
    expect(removeMeasurement(session, 'point-thigh')).toBe(session);
  });

  it('never mutates the session it was given', () => {
    const session = createSession('session-1', STARTED_AT);
    addMeasurement(session, measurement());
    expect(session.measurements).toEqual([]);

    const withOne = addMeasurement(session, measurement());
    removeMeasurement(withOne, 'point-waist');
    expect(withOne.measurements).toHaveLength(1);
  });
});

describe('session summary', () => {
  const POINTS: readonly CircumferencePoint[] = [
    { id: 'point-waist', code: 'waist', label: 'Waist', guideText: 'At the navel.', sortOrder: 3 },
    { id: 'point-neck', code: 'neck', label: 'Neck', guideText: 'Below the larynx.', sortOrder: 1 },
    { id: 'point-chest', code: 'chest', label: 'Chest', guideText: 'Widest point.', sortOrder: 2 },
  ];

  it('lists every point in anatomical order, not the order they were passed', () => {
    const summary = summariseSession(undefined, POINTS);

    expect(summary.rows.map((row) => row.point.label)).toEqual(['Neck', 'Chest', 'Waist']);
  });

  it('shows an unmeasured point as a gap rather than omitting it', () => {
    const session = addMeasurement(
      createSession('session-1', STARTED_AT),
      measurement({ pointId: 'point-waist' }),
    );

    const summary = summariseSession(session, POINTS);

    expect(summary.rows).toHaveLength(3);
    expect(summary.rows.find((row) => row.point.id === 'point-neck')?.measurement).toBeUndefined();
    expect(summary.rows.find((row) => row.point.id === 'point-waist')?.measurement?.valueCm).toBe(
      86.4,
    );
  });

  it('counts what is measured against the full set of points', () => {
    let session = createSession('session-1', STARTED_AT);
    session = addMeasurement(session, measurement({ id: 'm-1', pointId: 'point-waist' }));
    session = addMeasurement(session, measurement({ id: 'm-2', pointId: 'point-neck' }));

    const summary = summariseSession(session, POINTS);

    expect(summary.measuredCount).toBe(2);
    expect(summary.totalPoints).toBe(3);
    expect(summary.isComplete).toBe(false);
  });

  it('reports complete only when every point carries a value', () => {
    let session = createSession('session-1', STARTED_AT);
    for (const point of POINTS) {
      session = addMeasurement(session, measurement({ id: `m-${point.id}`, pointId: point.id }));
    }

    expect(summariseSession(session, POINTS).isComplete).toBe(true);
  });

  it('summarises a session that does not exist yet as all gaps', () => {
    const summary = summariseSession(undefined, POINTS);

    expect(summary.measuredCount).toBe(0);
    expect(summary.totalPoints).toBe(3);
    expect(summary.isComplete).toBe(false);
    expect(summary.rows.every((row) => row.measurement === undefined)).toBe(true);
  });

  it('does not call an empty point list complete', () => {
    const session = addMeasurement(createSession('session-1', STARTED_AT), measurement());

    expect(summariseSession(session, []).isComplete).toBe(false);
  });

  it('keeps a replaced value out of the summary', () => {
    let session = createSession('session-1', STARTED_AT);
    session = addMeasurement(session, measurement({ id: 'm-1', valueCm: 86.4 }));
    session = addMeasurement(session, measurement({ id: 'm-2', valueCm: 85.1 }));

    const waist = summariseSession(session, POINTS).rows.find(
      (row) => row.point.id === 'point-waist',
    );

    expect(waist?.measurement?.valueCm).toBe(85.1);
    expect(summariseSession(session, POINTS).measuredCount).toBe(1);
  });
});
