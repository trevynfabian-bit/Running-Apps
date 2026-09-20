/**
 * The history list has to answer "which way is this going" without the reader
 * doing arithmetic, and without inventing values for sessions that skipped the
 * point.
 */

import { describe, expect, it } from 'vitest';

import type { BodyMeasurement } from './body-composition';
import type { BodyCompositionSession } from './composition-session';
import { historyForPoint, latestForPoint } from './composition-history';
import { STUB_SESSION_HISTORY } from './composition-history-stub';

const WAIST = 'point-waist';
const THIGH = 'point-thigh';

function session(
  id: string,
  capturedAt: string,
  measurements: readonly Partial<BodyMeasurement>[],
): BodyCompositionSession {
  return {
    id,
    capturedAt,
    measurements: measurements.map((partial, index) => ({
      id: `${id}-${index}`,
      pointId: WAIST,
      valueCm: 86,
      recordedUnit: 'cm',
      capturedAt,
      ...partial,
    })),
  };
}

describe('per-metric history', () => {
  it('returns newest first regardless of the order sessions come in', () => {
    const history = historyForPoint(
      [
        session('older', '2026-06-01T08:00:00.000Z', [{ valueCm: 88 }]),
        session('newest', '2026-09-01T08:00:00.000Z', [{ valueCm: 85 }]),
        session('middle', '2026-07-01T08:00:00.000Z', [{ valueCm: 87 }]),
      ],
      WAIST,
    );

    expect(history.map((entry) => entry.sessionId)).toEqual(['newest', 'middle', 'older']);
  });

  it('carries the change from the next-older session', () => {
    const history = historyForPoint(
      [
        session('a', '2026-06-01T08:00:00.000Z', [{ valueCm: 88 }]),
        session('b', '2026-07-01T08:00:00.000Z', [{ valueCm: 87 }]),
        session('c', '2026-08-01T08:00:00.000Z', [{ valueCm: 85 }]),
      ],
      WAIST,
    );

    expect(history[0]?.changeCm).toBeCloseTo(-2, 10);
    expect(history[1]?.changeCm).toBeCloseTo(-1, 10);
  });

  it('leaves the oldest entry without a change rather than calling it zero', () => {
    const history = historyForPoint(
      [
        session('a', '2026-06-01T08:00:00.000Z', [{ valueCm: 88 }]),
        session('b', '2026-07-01T08:00:00.000Z', [{ valueCm: 88 }]),
      ],
      WAIST,
    );

    // A genuine no-change reads as 0 ...
    expect(history[0]?.changeCm).toBe(0);
    // ... and "nothing to compare to" stays undefined.
    expect(history[1]?.changeCm).toBeUndefined();
    expect('changeCm' in history[1]!).toBe(false);
  });

  it('skips sessions that did not measure the point instead of showing a gap', () => {
    const history = historyForPoint(
      [
        session('a', '2026-06-01T08:00:00.000Z', [{ pointId: WAIST, valueCm: 88 }]),
        session('b', '2026-07-01T08:00:00.000Z', [{ pointId: THIGH, valueCm: 56 }]),
        session('c', '2026-08-01T08:00:00.000Z', [{ pointId: WAIST, valueCm: 85 }]),
      ],
      WAIST,
    );

    expect(history).toHaveLength(2);
    // The change skips over the session that did not measure the waist.
    expect(history[0]?.changeCm).toBeCloseTo(-3, 10);
  });

  it('computes the change in centimetres across a unit switch', () => {
    const history = historyForPoint(
      [
        session('a', '2026-06-01T08:00:00.000Z', [{ valueCm: 88, recordedUnit: 'cm' }]),
        session('b', '2026-07-01T08:00:00.000Z', [{ valueCm: 86, recordedUnit: 'in' }]),
      ],
      WAIST,
    );

    expect(history[0]?.recordedUnit).toBe('in');
    expect(history[0]?.changeCm).toBeCloseTo(-2, 10);
  });

  it('is empty for a point never measured', () => {
    expect(historyForPoint([], WAIST)).toEqual([]);
    expect(
      historyForPoint([session('a', '2026-06-01T08:00:00.000Z', [{ pointId: THIGH }])], WAIST),
    ).toEqual([]);
  });

  it('reports the latest value, or nothing at all', () => {
    const sessions = [
      session('a', '2026-06-01T08:00:00.000Z', [{ valueCm: 88 }]),
      session('c', '2026-08-01T08:00:00.000Z', [{ valueCm: 85 }]),
    ];

    expect(latestForPoint(sessions, WAIST)?.valueCm).toBe(85);
    expect(latestForPoint(sessions, 'point-neck')).toBeUndefined();
  });
});

describe('stub session history', () => {
  it('reads as a plausible block the UI can be built against', () => {
    const waist = historyForPoint(STUB_SESSION_HISTORY, WAIST);

    expect(waist).toHaveLength(STUB_SESSION_HISTORY.length);
    // Newest first, and the waist is trending down across the block.
    expect(waist[0]!.valueCm).toBeLessThan(waist[waist.length - 1]!.valueCm);
    expect(waist.slice(0, -1).every((entry) => (entry.changeCm ?? 0) < 0)).toBe(true);
  });

  it('includes a session that skipped a point and one measured in inches', () => {
    // One session has no thigh value, so its history is shorter.
    expect(historyForPoint(STUB_SESSION_HISTORY, THIGH)).toHaveLength(
      STUB_SESSION_HISTORY.length - 1,
    );

    const inInches = historyForPoint(STUB_SESSION_HISTORY, WAIST).filter(
      (entry) => entry.recordedUnit === 'in',
    );
    expect(inInches).toHaveLength(1);
  });
});
