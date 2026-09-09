/**
 * Body composition: photos, tape measurements and body-fat estimates recorded
 * together as a session.
 *
 * This module holds the vocabulary the API, the database seed and the mobile
 * app share: which sides a portrait has, which tape points exist and how each
 * is measured, and which units are accepted. Calculations (body-fat formulas,
 * session comparison) arrive in their own engine and build on these types.
 *
 * Canonical unit for a circumference is centimetres, mirroring metres for
 * distance: inches are a presentation and input concern only.
 */

// ---------------------------------------------------------------------------
// Portrait
// ---------------------------------------------------------------------------

/** The four sides of a portrait, in display order. */
export const PHOTO_SIDES = ['front', 'back', 'left', 'right'] as const;

export type PhotoSide = (typeof PHOTO_SIDES)[number];

export function isPhotoSide(value: string): value is PhotoSide {
  return (PHOTO_SIDES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export const MEASUREMENT_UNITS = ['cm', 'in'] as const;

export type MeasurementUnit = (typeof MEASUREMENT_UNITS)[number];

export function isMeasurementUnit(value: string): value is MeasurementUnit {
  return (MEASUREMENT_UNITS as readonly string[]).includes(value);
}

export const CM_PER_INCH = 2.54;

export const inchesToCm = (inches: number): number => inches * CM_PER_INCH;
export const cmToInches = (cm: number): number => cm / CM_PER_INCH;

/** Normalise an entered circumference to the canonical unit. */
export function toCentimetres(value: number, unit: MeasurementUnit): number {
  return unit === 'cm' ? value : inchesToCm(value);
}

/** Express a canonical circumference in the athlete's chosen unit. */
export function fromCentimetres(cm: number, unit: MeasurementUnit): number {
  return unit === 'cm' ? cm : cmToInches(cm);
}

// ---------------------------------------------------------------------------
// Tape points
// ---------------------------------------------------------------------------

/**
 * Where a tape can be placed. The neck, waist and hips are what the
 * circumference body-fat formulas need; the limbs are for the athlete's own
 * tracking.
 */
export const CIRCUMFERENCE_POINT_CODES = [
  'neck',
  'chest',
  'waist',
  'hips',
  'left_arm',
  'right_arm',
  'left_thigh',
  'right_thigh',
] as const;

export type CircumferencePointCode = (typeof CIRCUMFERENCE_POINT_CODES)[number];

export function isCircumferencePointCode(value: string): value is CircumferencePointCode {
  return (CIRCUMFERENCE_POINT_CODES as readonly string[]).includes(value);
}

export interface CircumferencePointDefinition {
  code: CircumferencePointCode;
  label: string;
  /**
   * Where to put the tape, written for someone holding one. Landmarks are
   * specific because a tape moved two centimetres reads as a body change.
   */
  guideText: string;
  sortOrder: number;
}

/**
 * The reference catalog. The database table `circumference_points` is seeded
 * from this at migration time, so the guide text lives in one place.
 */
export const CIRCUMFERENCE_POINT_CATALOG: readonly CircumferencePointDefinition[] = [
  {
    code: 'neck',
    label: 'Neck',
    guideText: 'Just below the larynx, tape sloping slightly downward to the front.',
    sortOrder: 1,
  },
  {
    code: 'chest',
    label: 'Chest',
    guideText: 'Around the fullest part of the chest, tape level, after a normal exhale.',
    sortOrder: 2,
  },
  {
    code: 'waist',
    label: 'Waist',
    guideText: 'At the navel, tape level, relaxed and after a normal exhale.',
    sortOrder: 3,
  },
  {
    code: 'hips',
    label: 'Hips',
    guideText: 'Around the widest part of the hips and glutes, feet together.',
    sortOrder: 4,
  },
  {
    code: 'left_arm',
    label: 'Left arm',
    guideText: 'Midway between shoulder and elbow, arm relaxed at your side.',
    sortOrder: 5,
  },
  {
    code: 'right_arm',
    label: 'Right arm',
    guideText: 'Midway between shoulder and elbow, arm relaxed at your side.',
    sortOrder: 6,
  },
  {
    code: 'left_thigh',
    label: 'Left thigh',
    guideText: 'Just below the gluteal fold, standing with weight on both feet.',
    sortOrder: 7,
  },
  {
    code: 'right_thigh',
    label: 'Right thigh',
    guideText: 'Just below the gluteal fold, standing with weight on both feet.',
    sortOrder: 8,
  },
];

/** Look up a catalog entry by code. */
export function circumferencePoint(code: CircumferencePointCode): CircumferencePointDefinition {
  const found = CIRCUMFERENCE_POINT_CATALOG.find((p) => p.code === code);
  if (!found) throw new Error(`circumferencePoint: unknown code ${code}`);
  return found;
}
