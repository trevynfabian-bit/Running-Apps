import { describe, expect, it } from 'vitest';
import {
  COMPOSITION_SIDES,
  captureProgress,
  capturedSides,
  createSessionDraft,
  isSessionComplete,
  missingSides,
  nextSideToCapture,
  CIRCUMFERENCE_POINTS,
  canSaveSessionDraft,
  fromCentimetres,
  isPlausibleCircumference,
  measurementFor,
  photoForSide,
  putPhoto,
  putMeasurement,
  recordedPoints,
  removeMeasurement,
  removePhoto,
  toCentimetres,
  validateSessionDraft,
  type CompositionSessionDraft,
  type CircumferencePointCode,
  type CompositionSide,
  type MeasurementUnit,
} from './composition.js';

const startedAt = new Date('2026-09-17T08:00:00Z');

function capture(
  draft: CompositionSessionDraft,
  side: CompositionSide,
  uri = `file:///${side}.jpg`,
): CompositionSessionDraft {
  return putPhoto(draft, { side, uri, capturedAt: new Date('2026-09-17T08:05:00Z') });
}

describe('createSessionDraft', () => {
  it('starts with nothing captured and the front angle offered first', () => {
    const draft = createSessionDraft(startedAt);

    expect(draft.photos).toEqual([]);
    expect(draft.startedAt).toBe(startedAt);
    expect(nextSideToCapture(draft)).toBe('front');
    expect(isSessionComplete(draft)).toBe(false);
    expect(captureProgress(draft)).toEqual({ captured: 0, total: 4 });
  });
});

describe('putPhoto', () => {
  it('replaces the photo for a side instead of appending a second one', () => {
    const draft = capture(
      capture(createSessionDraft(startedAt), 'front'),
      'front',
      'file:///retake.jpg',
    );

    expect(draft.photos).toHaveLength(1);
    expect(photoForSide(draft, 'front')?.uri).toBe('file:///retake.jpg');
  });

  it('leaves the other sides untouched when one is retaken', () => {
    let draft = createSessionDraft(startedAt);
    for (const side of COMPOSITION_SIDES) draft = capture(draft, side);

    const retaken = capture(draft, 'left', 'file:///left-again.jpg');

    expect(retaken.photos).toHaveLength(4);
    expect(photoForSide(retaken, 'left')?.uri).toBe('file:///left-again.jpg');
    expect(photoForSide(retaken, 'front')?.uri).toBe('file:///front.jpg');
    expect(photoForSide(retaken, 'back')?.uri).toBe('file:///back.jpg');
    expect(photoForSide(retaken, 'right')?.uri).toBe('file:///right.jpg');
  });

  it('holds photos in capture order however they were taken', () => {
    let draft = createSessionDraft(startedAt);
    for (const side of ['right', 'front', 'left', 'back'] as const) draft = capture(draft, side);

    expect(draft.photos.map((photo) => photo.side)).toEqual(['front', 'back', 'left', 'right']);
  });
});

describe('nextSideToCapture', () => {
  it('walks the fixed order while the athlete captures in order', () => {
    let draft = createSessionDraft(startedAt);
    const offered: CompositionSide[] = [];

    for (let i = 0; i < COMPOSITION_SIDES.length; i += 1) {
      const side = nextSideToCapture(draft);
      expect(side).toBeDefined();
      offered.push(side!);
      draft = capture(draft, side!);
    }

    expect(offered).toEqual(['front', 'back', 'left', 'right']);
    expect(nextSideToCapture(draft)).toBeUndefined();
  });

  it('returns the first gap so an interrupted session resumes rather than restarts', () => {
    const draft = capture(capture(createSessionDraft(startedAt), 'front'), 'left');

    expect(missingSides(draft)).toEqual(['back', 'right']);
    expect(nextSideToCapture(draft)).toBe('back');
  });
});

describe('completeness', () => {
  it('is complete only once all four sides exist', () => {
    let draft = createSessionDraft(startedAt);

    for (const side of COMPOSITION_SIDES) {
      expect(isSessionComplete(draft)).toBe(false);
      draft = capture(draft, side);
    }

    expect(isSessionComplete(draft)).toBe(true);
    expect(capturedSides(draft)).toEqual(['front', 'back', 'left', 'right']);
    expect(captureProgress(draft)).toEqual({ captured: 4, total: 4 });
  });

  it('stops being complete when a side is discarded', () => {
    let draft = createSessionDraft(startedAt);
    for (const side of COMPOSITION_SIDES) draft = capture(draft, side);

    const reduced = removePhoto(draft, 'back');

    expect(isSessionComplete(reduced)).toBe(false);
    expect(nextSideToCapture(reduced)).toBe('back');
    expect(captureProgress(reduced)).toEqual({ captured: 3, total: 4 });
  });
});

describe('immutability', () => {
  it('never mutates the draft it was given', () => {
    const draft = createSessionDraft(startedAt);
    const withFront = capture(draft, 'front');

    expect(draft.photos).toEqual([]);
    expect(withFront).not.toBe(draft);
    expect(removePhoto(withFront, 'front').photos).toEqual([]);
    expect(withFront.photos).toHaveLength(1);
  });
});

describe('validateSessionDraft', () => {
  it('reports every outstanding angle in one problem, in capture order', () => {
    const draft = capture(createSessionDraft(startedAt), 'left');

    expect(validateSessionDraft(draft)).toEqual([
      { kind: 'missing_sides', sides: ['front', 'back', 'right'] },
    ]);
    expect(canSaveSessionDraft(draft)).toBe(false);
  });

  it('clears once all four angles are present', () => {
    let draft = createSessionDraft(startedAt);
    for (const side of COMPOSITION_SIDES) draft = capture(draft, side);

    expect(validateSessionDraft(draft)).toEqual([]);
    expect(canSaveSessionDraft(draft)).toBe(true);
  });

  it('rejects a blank photo reference even when all four sides exist', () => {
    let draft = createSessionDraft(startedAt);
    for (const side of COMPOSITION_SIDES) draft = capture(draft, side);
    draft = capture(draft, 'back', '   ');

    expect(validateSessionDraft(draft)).toEqual([{ kind: 'unusable_photo', side: 'back' }]);
    expect(canSaveSessionDraft(draft)).toBe(false);
  });

  it('reports a missing angle and an unusable one together', () => {
    let draft = createSessionDraft(startedAt);
    for (const side of ['front', 'back', 'left'] as const) draft = capture(draft, side);
    draft = capture(draft, 'front', '');

    expect(validateSessionDraft(draft)).toEqual([
      { kind: 'missing_sides', sides: ['right'] },
      { kind: 'unusable_photo', side: 'front' },
    ]);
  });

  it('refuses an empty draft', () => {
    const draft = createSessionDraft(startedAt);

    expect(canSaveSessionDraft(draft)).toBe(false);
    expect(validateSessionDraft(draft)).toEqual([
      { kind: 'missing_sides', sides: ['front', 'back', 'left', 'right'] },
    ]);
  });
});

describe('replacing one angle leaves the rest alone', () => {
  function fullDraft(): CompositionSessionDraft {
    let draft = createSessionDraft(startedAt);
    for (const side of COMPOSITION_SIDES) draft = capture(draft, side);
    return draft;
  }

  it('keeps the other three as the very same objects, not rebuilt copies', () => {
    const before = fullDraft();
    const untouched = (['front', 'back', 'right'] as const).map((side) =>
      photoForSide(before, side),
    );

    const after = capture(before, 'left', 'file:///left-again.jpg');

    // Identity, not equality: a rebuild that happened to produce equal values
    // would still mean the replacement had reached angles it has no business
    // touching.
    for (const [index, side] of (['front', 'back', 'right'] as const).entries()) {
      expect(photoForSide(after, side)).toBe(untouched[index]);
    }
  });

  it('never grows the set, however many times one angle is redone', () => {
    let draft = fullDraft();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      draft = capture(draft, 'back', `file:///back-${attempt}.jpg`);
    }

    expect(draft.photos).toHaveLength(4);
    expect(photoForSide(draft, 'back')?.uri).toBe('file:///back-4.jpg');
    expect(capturedSides(draft)).toEqual(['front', 'back', 'left', 'right']);
  });

  it('holds capture order and the session start through a replacement', () => {
    const after = capture(fullDraft(), 'front', 'file:///front-again.jpg');

    expect(after.photos.map((photo) => photo.side)).toEqual(['front', 'back', 'left', 'right']);
    expect(after.startedAt).toBe(startedAt);
  });

  it('leaves a complete session complete and still saveable', () => {
    const after = capture(fullDraft(), 'right', 'file:///right-again.jpg');

    expect(isSessionComplete(after)).toBe(true);
    expect(canSaveSessionDraft(after)).toBe(true);
    expect(missingSides(after)).toEqual([]);
  });

  it('does not touch the draft it replaced from', () => {
    const before = fullDraft();
    capture(before, 'left', 'file:///left-again.jpg');

    expect(photoForSide(before, 'left')?.uri).toBe('file:///left.jpg');
    expect(before.photos).toHaveLength(4);
  });
});

describe('circumference measurements', () => {
  const recordedAt = new Date('2026-09-17T08:10:00Z');

  function record(
    draft: CompositionSessionDraft,
    point: CircumferencePointCode,
    value: number,
    unit: MeasurementUnit = 'cm',
  ): CompositionSessionDraft {
    return putMeasurement(draft, {
      point,
      centimetres: toCentimetres(value, unit),
      enteredUnit: unit,
      recordedAt,
    });
  }

  it('starts empty and does not block saving a photo-only session', () => {
    let draft = createSessionDraft(startedAt);
    for (const side of COMPOSITION_SIDES) draft = capture(draft, side);

    expect(draft.measurements).toEqual([]);
    expect(canSaveSessionDraft(draft)).toBe(true);
  });

  it('converts inches to centimetres and reads back in the unit entered', () => {
    const draft = record(createSessionDraft(startedAt), 'waist', 32, 'in');
    const waist = measurementFor(draft, 'waist');

    expect(waist?.centimetres).toBeCloseTo(81.28, 6);
    expect(waist?.enteredUnit).toBe('in');
    expect(fromCentimetres(waist!.centimetres, 'in')).toBeCloseTo(32, 6);
  });

  it('round-trips a centimetre value untouched', () => {
    const draft = record(createSessionDraft(startedAt), 'neck', 38.5);

    expect(measurementFor(draft, 'neck')?.centimetres).toBe(38.5);
    expect(toCentimetres(38.5, 'cm')).toBe(38.5);
  });

  it('corrects a point in place rather than recording it twice', () => {
    let draft = record(createSessionDraft(startedAt), 'waist', 84);
    draft = record(draft, 'waist', 83.2);

    expect(draft.measurements).toHaveLength(1);
    expect(measurementFor(draft, 'waist')?.centimetres).toBe(83.2);
  });

  it('leaves the other points alone when one is corrected', () => {
    let draft = record(createSessionDraft(startedAt), 'neck', 38);
    draft = record(draft, 'waist', 84);
    const neck = measurementFor(draft, 'neck');

    const corrected = record(draft, 'waist', 83);

    expect(measurementFor(corrected, 'neck')).toBe(neck);
    expect(corrected.measurements).toHaveLength(2);
  });

  it('holds readings in registry order however they were entered', () => {
    let draft = createSessionDraft(startedAt);
    draft = record(draft, 'right_thigh', 58);
    draft = record(draft, 'neck', 38);
    draft = record(draft, 'waist', 84);

    expect(draft.measurements.map((m) => m.point)).toEqual(['neck', 'waist', 'right_thigh']);
    expect(recordedPoints(draft)).toEqual(['neck', 'waist', 'right_thigh']);
  });

  it('drops one point without disturbing the rest', () => {
    let draft = record(createSessionDraft(startedAt), 'neck', 38);
    draft = record(draft, 'waist', 84);

    const reduced = removeMeasurement(draft, 'neck');

    expect(recordedPoints(reduced)).toEqual(['waist']);
    expect(draft.measurements).toHaveLength(2);
  });

  it('accepts a human circumference and rejects a slipped decimal or wrong unit', () => {
    expect(isPlausibleCircumference(84)).toBe(true);
    expect(isPlausibleCircumference(5)).toBe(true);
    expect(isPlausibleCircumference(250)).toBe(true);

    expect(isPlausibleCircumference(0)).toBe(false);
    expect(isPlausibleCircumference(-84)).toBe(false);
    expect(isPlausibleCircumference(840)).toBe(false);
    expect(isPlausibleCircumference(Number.NaN)).toBe(false);
    expect(isPlausibleCircumference(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('keeps photos and measurements on the one session', () => {
    let draft = createSessionDraft(startedAt);
    for (const side of COMPOSITION_SIDES) draft = capture(draft, side);
    draft = record(draft, 'waist', 84);

    expect(draft.photos).toHaveLength(4);
    expect(draft.measurements).toHaveLength(1);
    expect(isSessionComplete(draft)).toBe(true);
  });
});

describe('CIRCUMFERENCE_POINTS', () => {
  it('has unique codes, since a duplicate would silently merge two points', () => {
    const codes = CIRCUMFERENCE_POINTS.map((point) => point.code);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it('carries the three points the body fat estimate needs', () => {
    const codes = CIRCUMFERENCE_POINTS.map((point) => point.code);

    expect(codes).toContain('neck');
    expect(codes).toContain('waist');
    expect(codes).toContain('hips');
  });

  it('gives every point a label to show', () => {
    for (const point of CIRCUMFERENCE_POINTS) {
      expect(point.label.trim()).not.toBe('');
    }
  });
});
