import { describe, expect, it } from 'vitest';
import {
  COMPOSITION_SIDES,
  captureProgress,
  capturedSides,
  createSessionDraft,
  isSessionComplete,
  missingSides,
  nextSideToCapture,
  canSaveSessionDraft,
  photoForSide,
  putPhoto,
  removePhoto,
  validateSessionDraft,
  type CompositionSessionDraft,
  type CompositionSide,
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
