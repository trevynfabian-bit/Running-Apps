/**
 * Past composition sessions, stubbed.
 *
 * Stands in for the history endpoint while the frontend is built. Kept in its
 * own file so deleting it when the API lands is a single removal rather than a
 * hunt through a module that also holds real logic.
 *
 * The numbers are not random. They describe a plausible three-month block: a
 * waist coming down steadily, a chest and arm holding or creeping up slightly,
 * and one session where the athlete measured in inches — that last one exists
 * so the unit handling is exercised by the fixtures rather than only by tests.
 * One session skips the thigh, so the "not every session measures every point"
 * case shows up in the UI too.
 */

import type { BodyCompositionSession } from './composition-session';

/** Helper keeps the fixtures below readable — ids are positional, not meaningful. */
function cm(
  sessionId: string,
  pointId: string,
  valueCm: number,
  capturedAt: string,
  recordedUnit: 'cm' | 'in' = 'cm',
): {
  id: string;
  pointId: string;
  valueCm: number;
  recordedUnit: 'cm' | 'in';
  capturedAt: string;
} {
  return { id: `${sessionId}-${pointId}`, pointId, valueCm, recordedUnit, capturedAt };
}

export const STUB_SESSION_HISTORY: readonly BodyCompositionSession[] = [
  {
    id: 'session-2026-06-14',
    capturedAt: '2026-06-14T07:30:00.000Z',
    measurements: [
      cm('session-2026-06-14', 'point-neck', 38.5, '2026-06-14T07:30:00.000Z'),
      cm('session-2026-06-14', 'point-chest', 99.0, '2026-06-14T07:30:00.000Z'),
      cm('session-2026-06-14', 'point-waist', 88.2, '2026-06-14T07:30:00.000Z'),
      cm('session-2026-06-14', 'point-hips', 98.5, '2026-06-14T07:30:00.000Z'),
      cm('session-2026-06-14', 'point-left-arm', 32.0, '2026-06-14T07:30:00.000Z'),
      cm('session-2026-06-14', 'point-right-arm', 32.4, '2026-06-14T07:30:00.000Z'),
      cm('session-2026-06-14', 'point-thigh', 56.0, '2026-06-14T07:30:00.000Z'),
    ],
  },
  {
    id: 'session-2026-07-12',
    capturedAt: '2026-07-12T07:15:00.000Z',
    measurements: [
      cm('session-2026-07-12', 'point-neck', 38.4, '2026-07-12T07:15:00.000Z'),
      cm('session-2026-07-12', 'point-chest', 99.4, '2026-07-12T07:15:00.000Z'),
      cm('session-2026-07-12', 'point-waist', 87.1, '2026-07-12T07:15:00.000Z'),
      cm('session-2026-07-12', 'point-hips', 98.0, '2026-07-12T07:15:00.000Z'),
      cm('session-2026-07-12', 'point-left-arm', 32.3, '2026-07-12T07:15:00.000Z'),
      cm('session-2026-07-12', 'point-right-arm', 32.6, '2026-07-12T07:15:00.000Z'),
      // Thigh skipped this session — the history must not invent a value.
    ],
  },
  {
    // Measured on a tape marked in inches; values are stored canonically.
    id: 'session-2026-08-09',
    capturedAt: '2026-08-09T08:00:00.000Z',
    measurements: [
      cm('session-2026-08-09', 'point-neck', 38.1, '2026-08-09T08:00:00.000Z', 'in'),
      cm('session-2026-08-09', 'point-chest', 99.7, '2026-08-09T08:00:00.000Z', 'in'),
      cm('session-2026-08-09', 'point-waist', 86.0, '2026-08-09T08:00:00.000Z', 'in'),
      cm('session-2026-08-09', 'point-hips', 97.5, '2026-08-09T08:00:00.000Z', 'in'),
      cm('session-2026-08-09', 'point-left-arm', 32.5, '2026-08-09T08:00:00.000Z', 'in'),
      cm('session-2026-08-09', 'point-right-arm', 32.8, '2026-08-09T08:00:00.000Z', 'in'),
      cm('session-2026-08-09', 'point-thigh', 55.4, '2026-08-09T08:00:00.000Z', 'in'),
    ],
  },
  {
    id: 'session-2026-09-06',
    capturedAt: '2026-09-06T07:45:00.000Z',
    measurements: [
      cm('session-2026-09-06', 'point-neck', 38.0, '2026-09-06T07:45:00.000Z'),
      cm('session-2026-09-06', 'point-chest', 99.8, '2026-09-06T07:45:00.000Z'),
      cm('session-2026-09-06', 'point-waist', 85.3, '2026-09-06T07:45:00.000Z'),
      cm('session-2026-09-06', 'point-hips', 97.2, '2026-09-06T07:45:00.000Z'),
      cm('session-2026-09-06', 'point-left-arm', 32.6, '2026-09-06T07:45:00.000Z'),
      cm('session-2026-09-06', 'point-right-arm', 32.9, '2026-09-06T07:45:00.000Z'),
      cm('session-2026-09-06', 'point-thigh', 55.1, '2026-09-06T07:45:00.000Z'),
    ],
  },
];
