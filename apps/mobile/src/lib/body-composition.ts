/**
 * Body composition — client types and stub data.
 *
 * The API for this module does not exist yet, so the screens are built against
 * the contract described in the PRD and fed from the fixtures below. Every
 * shape here is the one the client expects back from the server, so wiring the
 * real endpoints later is a swap of the data source, not a rewrite of the UI.
 *
 * Measurements carry two facts about units, and both matter:
 *   `valueCm`       the canonical value, always centimetres, what gets compared
 *   `recordedUnit`  the unit the athlete actually read off the tape
 *
 * Keeping the second is what lets the app re-display an entry honestly after
 * the athlete switches their default — a waist measured as 34 in is shown as
 * 34.0 in, not as the 86.36 cm that a naive round-trip would produce.
 */

import type { LengthUnit } from '@running/core';

export interface CircumferencePoint {
  id: string;
  /** Stable code the API keys measurements by, e.g. `waist`. */
  code: string;
  label: string;
  /** Where to put the tape. Shown next to the input, not behind a tooltip. */
  guideText: string;
  sortOrder: number;
}

export interface BodyMeasurement {
  id: string;
  pointId: string;
  /** Canonical centimetres — never the raw number the athlete typed. */
  valueCm: number;
  recordedUnit: LengthUnit;
  /** ISO-8601. */
  capturedAt: string;
}

/**
 * Measure points.
 *
 * Ordered the way an athlete works down their own body with a tape, so the
 * picker reads as a sequence rather than an alphabetised list.
 */
export const STUB_CIRCUMFERENCE_POINTS: readonly CircumferencePoint[] = [
  {
    id: 'point-neck',
    code: 'neck',
    label: 'Neck',
    guideText: 'Just below the larynx, tape sloping slightly down at the front.',
    sortOrder: 1,
  },
  {
    id: 'point-chest',
    code: 'chest',
    label: 'Chest',
    guideText: 'Across the widest point, arms relaxed, at the end of a normal breath out.',
    sortOrder: 2,
  },
  {
    id: 'point-waist',
    code: 'waist',
    label: 'Waist',
    guideText: 'At the navel, tape level all the way round, without pulling it tight.',
    sortOrder: 3,
  },
  {
    id: 'point-hips',
    code: 'hips',
    label: 'Hips',
    guideText: 'Around the widest part of the glutes, feet together.',
    sortOrder: 4,
  },
  {
    id: 'point-left-arm',
    code: 'left_arm',
    label: 'Left arm',
    guideText: 'Mid-way between shoulder and elbow, arm hanging relaxed.',
    sortOrder: 5,
  },
  {
    id: 'point-right-arm',
    code: 'right_arm',
    label: 'Right arm',
    guideText: 'Mid-way between shoulder and elbow, arm hanging relaxed.',
    sortOrder: 6,
  },
  {
    id: 'point-thigh',
    code: 'thigh',
    label: 'Thigh',
    guideText: 'Mid-way between hip crease and knee, weight evenly on both feet.',
    sortOrder: 7,
  },
];

export function findPoint(pointId: string): CircumferencePoint | undefined {
  return STUB_CIRCUMFERENCE_POINTS.find((point) => point.id === pointId);
}
