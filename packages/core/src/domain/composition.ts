/**
 * Body composition sessions.
 *
 * A session is one sitting: the athlete photographed from four fixed angles,
 * with circumference measurements recorded alongside. The four angles are the
 * unit of comparison — a front photo held up against an older session that only
 * has a side view tells the athlete nothing — so a session is only comparable
 * once all four sides exist. That is why completeness is modelled here rather
 * than left to the screen to remember.
 *
 * Capture order is fixed. Two sessions photographed in a different order are
 * harder to compare than they need to be, and the athlete is standing in front
 * of a camera deciding nothing.
 *
 * Pure, like the rest of this package: the caller injects capture timestamps
 * rather than the functions reading a clock, so a flow can be replayed in a
 * test and produce the same draft every time.
 */

/** Capture order. Front first because it is the easiest to align against. */
export const COMPOSITION_SIDES = ['front', 'back', 'left', 'right'] as const;

export type CompositionSide = (typeof COMPOSITION_SIDES)[number];

export const COMPOSITION_SIDE_LABELS: Readonly<Record<CompositionSide, string>> = {
  front: 'Front',
  back: 'Back',
  left: 'Left side',
  right: 'Right side',
};

/**
 * One photograph held in a draft session.
 *
 * `uri` is a local device URI. Nothing leaves the device until the athlete
 * saves the session, so an abandoned draft never becomes an upload.
 */
export interface CompositionPhotoDraft {
  side: CompositionSide;
  uri: string;
  capturedAt: Date;
}

/**
 * A session being captured, before it is saved.
 *
 * Draft, not record: it has no id, because an id is assigned by the API when
 * the session is persisted.
 */
export interface CompositionSessionDraft {
  startedAt: Date;
  /** Always held in `COMPOSITION_SIDES` order, at most one photo per side. */
  photos: readonly CompositionPhotoDraft[];
  /**
   * Tape readings taken in the same sitting, in registry order, at most one per
   * point. Optional: a session of photographs alone is still a session, and
   * refusing to save one would just mean the athlete takes none.
   */
  measurements: readonly BodyMeasurementDraft[];
}

export function createSessionDraft(startedAt: Date): CompositionSessionDraft {
  return { startedAt, photos: [], measurements: [] };
}

export function photoForSide(
  draft: CompositionSessionDraft,
  side: CompositionSide,
): CompositionPhotoDraft | undefined {
  return draft.photos.find((photo) => photo.side === side);
}

/**
 * Add or replace the photo for a side.
 *
 * Replacement rather than append is the whole point: retaking one angle must
 * not cost the athlete the other three, and a side can never end up with two
 * competing photos.
 */
export function putPhoto(
  draft: CompositionSessionDraft,
  photo: CompositionPhotoDraft,
): CompositionSessionDraft {
  const others = draft.photos.filter((existing) => existing.side !== photo.side);
  return { ...draft, photos: inSideOrder([...others, photo]) };
}

export function removePhoto(
  draft: CompositionSessionDraft,
  side: CompositionSide,
): CompositionSessionDraft {
  return { ...draft, photos: draft.photos.filter((photo) => photo.side !== side) };
}

/** Sides that have a photo, in capture order. */
export function capturedSides(draft: CompositionSessionDraft): readonly CompositionSide[] {
  return COMPOSITION_SIDES.filter((side) => draft.photos.some((photo) => photo.side === side));
}

/** Sides still outstanding, in capture order. */
export function missingSides(draft: CompositionSessionDraft): readonly CompositionSide[] {
  return COMPOSITION_SIDES.filter((side) => !draft.photos.some((photo) => photo.side === side));
}

/**
 * The side the flow should offer next, or `undefined` when the set is complete.
 *
 * Resuming an interrupted session lands on the first gap rather than restarting
 * at the front.
 */
export function nextSideToCapture(draft: CompositionSessionDraft): CompositionSide | undefined {
  return missingSides(draft)[0];
}

export function isSessionComplete(draft: CompositionSessionDraft): boolean {
  return missingSides(draft).length === 0;
}

export function captureProgress(draft: CompositionSessionDraft): {
  captured: number;
  total: number;
} {
  return { captured: capturedSides(draft).length, total: COMPOSITION_SIDES.length };
}

function inSideOrder(photos: readonly CompositionPhotoDraft[]): CompositionPhotoDraft[] {
  return [...photos].sort(
    (a, b) => COMPOSITION_SIDES.indexOf(a.side) - COMPOSITION_SIDES.indexOf(b.side),
  );
}

/**
 * Why a draft cannot be saved yet.
 *
 * Reported as a list rather than a first failure: the athlete should see
 * everything standing between them and a saved session in one go, not discover
 * the next problem after fixing this one.
 *
 * Codes, not sentences. The wording belongs to whatever is showing it.
 */
export type SessionDraftProblem =
  | { kind: 'missing_sides'; sides: readonly CompositionSide[] }
  /** A picker handed back something that is not a usable reference. */
  | { kind: 'unusable_photo'; side: CompositionSide };

/**
 * Everything wrong with a draft, in the order it is worth fixing.
 *
 * An empty list means the session is ready to save.
 */
export function validateSessionDraft(
  draft: CompositionSessionDraft,
): readonly SessionDraftProblem[] {
  const problems: SessionDraftProblem[] = [];

  const missing = missingSides(draft);
  if (missing.length > 0) problems.push({ kind: 'missing_sides', sides: missing });

  // Checked rather than assumed: a cancelled or partly failed pick can resolve
  // to a blank reference, and a session saved around one loses that angle
  // silently — which is the one failure mode this whole flow exists to avoid.
  for (const side of COMPOSITION_SIDES) {
    const photo = photoForSide(draft, side);
    if (photo && photo.uri.trim() === '') problems.push({ kind: 'unusable_photo', side });
  }

  return problems;
}

export function canSaveSessionDraft(draft: CompositionSessionDraft): boolean {
  return validateSessionDraft(draft).length === 0;
}

// ---------------------------------------------------------------------------
// Circumference measurements
// ---------------------------------------------------------------------------

/**
 * The points a tape measure is put around, in the order they are worked down
 * the body.
 *
 * A fixed registry rather than free text. Two sessions are only comparable if
 * "waist" meant the same place both times, and a typed-in name means whatever
 * the athlete was thinking that morning. Neck, waist and hips are load-bearing
 * beyond display: they are the inputs the circumference-based body fat estimate
 * needs.
 *
 * Grouped by region so the list can be worked down the body in one pass rather
 * than jumped around, which is also the order the tape naturally travels.
 *
 * Codes and labels only. Where to put the tape is instruction, and instruction
 * belongs to whatever is showing it.
 */
export const CIRCUMFERENCE_REGIONS = ['torso', 'arms', 'legs'] as const;

export type CircumferenceRegion = (typeof CIRCUMFERENCE_REGIONS)[number];

export const CIRCUMFERENCE_POINTS = [
  { code: 'neck', label: 'Neck', region: 'torso' },
  { code: 'chest', label: 'Chest', region: 'torso' },
  { code: 'waist', label: 'Waist', region: 'torso' },
  { code: 'hips', label: 'Hips', region: 'torso' },
  { code: 'left_arm', label: 'Left arm', region: 'arms' },
  { code: 'right_arm', label: 'Right arm', region: 'arms' },
  { code: 'left_thigh', label: 'Left thigh', region: 'legs' },
  { code: 'right_thigh', label: 'Right thigh', region: 'legs' },
] as const;

export type CircumferencePoint = (typeof CIRCUMFERENCE_POINTS)[number];

export type CircumferencePointCode = CircumferencePoint['code'];

/** The points of one region, in registry order. */
export function pointsInRegion(region: CircumferenceRegion): readonly CircumferencePoint[] {
  return CIRCUMFERENCE_POINTS.filter((point) => point.region === region);
}

export type MeasurementUnit = 'cm' | 'in';

export const CENTIMETRES_PER_INCH = 2.54;

export function toCentimetres(value: number, unit: MeasurementUnit): number {
  return unit === 'in' ? value * CENTIMETRES_PER_INCH : value;
}

export function fromCentimetres(centimetres: number, unit: MeasurementUnit): number {
  return unit === 'in' ? centimetres / CENTIMETRES_PER_INCH : centimetres;
}

/**
 * One tape reading.
 *
 * Held in centimetres whatever the athlete typed, with the unit they typed it
 * in kept alongside. Storing the number as entered would mean every comparison
 * and every formula has to ask which unit this row is in, and the first place
 * that forgets produces a trend with a 2.54x step in it. Keeping the entered
 * unit costs one field and means the value reads back the way it was written.
 */
export interface BodyMeasurementDraft {
  point: CircumferencePointCode;
  centimetres: number;
  enteredUnit: MeasurementUnit;
  recordedAt: Date;
}

/**
 * A circumference that could plausibly have come off a person.
 *
 * Deliberately wide. This is here to catch a slipped decimal point or a value
 * typed in the wrong unit, not to have an opinion about anyone's body.
 */
export function isPlausibleCircumference(centimetres: number): boolean {
  return Number.isFinite(centimetres) && centimetres >= 5 && centimetres <= 250;
}

export function measurementFor(
  draft: CompositionSessionDraft,
  point: CircumferencePointCode,
): BodyMeasurementDraft | undefined {
  return draft.measurements.find((measurement) => measurement.point === point);
}

/** Add or correct one point's reading, leaving every other point alone. */
export function putMeasurement(
  draft: CompositionSessionDraft,
  measurement: BodyMeasurementDraft,
): CompositionSessionDraft {
  const others = draft.measurements.filter((existing) => existing.point !== measurement.point);
  return { ...draft, measurements: inPointOrder([...others, measurement]) };
}

export function removeMeasurement(
  draft: CompositionSessionDraft,
  point: CircumferencePointCode,
): CompositionSessionDraft {
  return {
    ...draft,
    measurements: draft.measurements.filter((measurement) => measurement.point !== point),
  };
}

/** Points that have a reading, in registry order. */
export function recordedPoints(draft: CompositionSessionDraft): readonly CircumferencePointCode[] {
  return CIRCUMFERENCE_POINTS.map((point) => point.code).filter((code) =>
    draft.measurements.some((measurement) => measurement.point === code),
  );
}

function inPointOrder(measurements: readonly BodyMeasurementDraft[]): BodyMeasurementDraft[] {
  const order = CIRCUMFERENCE_POINTS.map((point) => point.code);
  return [...measurements].sort((a, b) => order.indexOf(a.point) - order.indexOf(b.point));
}
