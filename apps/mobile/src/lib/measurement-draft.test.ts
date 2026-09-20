/**
 * The behaviour these lock down: moving between measure points must not lose
 * what was typed, and must not carry it into the wrong point either.
 */

import { describe, expect, it } from 'vitest';

import {
  EMPTY_DRAFT,
  clearDraft,
  isDraftEmpty,
  readDraft,
  startedPointIds,
  writeDraft,
  type DraftsByPoint,
} from './measurement-draft';

const WAIST = 'point-waist';
const CHEST = 'point-chest';

describe('per-point measurement drafts', () => {
  it('gives an untouched point an empty draft rather than undefined', () => {
    expect(readDraft({}, WAIST)).toEqual(EMPTY_DRAFT);
    expect(readDraft({}, WAIST).value).toBe('');
  });

  it('keeps a value when the athlete moves to another point and back', () => {
    const drafts = writeDraft({}, WAIST, { value: '86.4' });

    // Away to the chest: its own field is empty, not the waist's number.
    expect(readDraft(drafts, CHEST).value).toBe('');

    // Back to the waist: still there.
    expect(readDraft(drafts, WAIST).value).toBe('86.4');
  });

  it('keeps each point separate when several are in progress', () => {
    let drafts: DraftsByPoint = {};
    drafts = writeDraft(drafts, WAIST, { value: '86.4' });
    drafts = writeDraft(drafts, CHEST, { value: '101' });

    expect(readDraft(drafts, WAIST).value).toBe('86.4');
    expect(readDraft(drafts, CHEST).value).toBe('101');
  });

  it('carries the unit with the draft, so a number is never reinterpreted', () => {
    let drafts: DraftsByPoint = {};
    drafts = writeDraft(drafts, WAIST, { value: '34', unit: 'in' });
    drafts = writeDraft(drafts, CHEST, { value: '101' });

    // The waist was typed in inches and stays inches.
    expect(readDraft(drafts, WAIST)).toEqual({ value: '34', unit: 'in' });
    // The chest never overrode, so it still follows whatever the default is.
    expect(readDraft(drafts, CHEST).unit).toBeUndefined();
  });

  it('merges a patch instead of replacing the draft', () => {
    let drafts = writeDraft({}, WAIST, { value: '34', unit: 'in' });
    drafts = writeDraft(drafts, WAIST, { value: '35' });

    expect(readDraft(drafts, WAIST)).toEqual({ value: '35', unit: 'in' });
  });

  it('drops a draft that has been emptied rather than storing a blank', () => {
    let drafts = writeDraft({}, WAIST, { value: '86.4' });
    expect(startedPointIds(drafts)).toEqual([WAIST]);

    drafts = writeDraft(drafts, WAIST, { value: '' });
    expect(startedPointIds(drafts)).toEqual([]);
  });

  it('keeps a cleared value that still carries a unit override', () => {
    const drafts = writeDraft({}, WAIST, { value: '', unit: 'in' });
    // The athlete deleted the number but still means inches — that is a choice
    // worth remembering, so the draft survives.
    expect(startedPointIds(drafts)).toEqual([WAIST]);
    expect(readDraft(drafts, WAIST).unit).toBe('in');
  });

  it('clears one point without disturbing the others', () => {
    let drafts: DraftsByPoint = {};
    drafts = writeDraft(drafts, WAIST, { value: '86.4' });
    drafts = writeDraft(drafts, CHEST, { value: '101' });

    drafts = clearDraft(drafts, WAIST);

    expect(readDraft(drafts, WAIST).value).toBe('');
    expect(readDraft(drafts, CHEST).value).toBe('101');
  });

  it('treats clearing an untouched point as a no-op', () => {
    const drafts = writeDraft({}, CHEST, { value: '101' });
    expect(clearDraft(drafts, WAIST)).toBe(drafts);
  });

  it('never mutates the map it was given', () => {
    const before = writeDraft({}, WAIST, { value: '86.4' });
    const snapshot = JSON.parse(JSON.stringify(before)) as DraftsByPoint;

    writeDraft(before, CHEST, { value: '101' });
    clearDraft(before, WAIST);

    expect(before).toEqual(snapshot);
  });

  it('recognises an empty draft', () => {
    expect(isDraftEmpty({ value: '' })).toBe(true);
    expect(isDraftEmpty({ value: '   ' })).toBe(true);
    expect(isDraftEmpty({ value: '', unit: 'in' })).toBe(false);
    expect(isDraftEmpty({ value: '86.4' })).toBe(false);
  });
});
