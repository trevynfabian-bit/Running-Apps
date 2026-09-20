/**
 * In-progress circumference entries, kept per measure point.
 *
 * An athlete working through a session does not type one number and stop. They
 * measure their waist, notice the tape slipped, jump to the chest, come back.
 * A single shared input would lose the waist value the moment they moved away —
 * worse, it would carry that number into the chest field, where it looks like a
 * real measurement of the wrong body part.
 *
 * So every point holds its own draft, and switching points swaps the form's
 * contents rather than clearing or reusing them. The unit travels with the
 * draft for the same reason: a number typed as inches must not be reinterpreted
 * as centimetres because the athlete visited another point in between.
 *
 * Pure and serialisable on purpose — it is the part of the entry form worth
 * testing, and the part a later task can persist across app restarts without
 * reaching into component state.
 */

import type { LengthUnit } from '@running/core';

export interface MeasurementDraft {
  /** Exactly what is in the text field, unparsed. */
  value: string;
  /**
   * The unit this draft is being typed in, when it deviates from the athlete's
   * default. `undefined` means "follow the default", which is what keeps a
   * changed default reaching drafts that never overrode it.
   */
  unit?: LengthUnit;
}

export type DraftsByPoint = Readonly<Record<string, MeasurementDraft>>;

export const EMPTY_DRAFT: MeasurementDraft = { value: '' };

/** True when a draft holds nothing worth remembering. */
export function isDraftEmpty(draft: MeasurementDraft): boolean {
  return draft.value.trim() === '' && draft.unit === undefined;
}

/** The draft for a point, or an empty one for a point not yet touched. */
export function readDraft(drafts: DraftsByPoint, pointId: string): MeasurementDraft {
  return drafts[pointId] ?? EMPTY_DRAFT;
}

/**
 * Apply a partial change to one point's draft.
 *
 * A draft that ends up empty is removed rather than stored as a blank, so the
 * map only ever holds points with something in progress. That keeps "which
 * points has the athlete started?" answerable straight from the keys.
 */
export function writeDraft(
  drafts: DraftsByPoint,
  pointId: string,
  patch: Partial<MeasurementDraft>,
): DraftsByPoint {
  const next: MeasurementDraft = { ...readDraft(drafts, pointId), ...patch };

  if (isDraftEmpty(next)) return clearDraft(drafts, pointId);

  return { ...drafts, [pointId]: next };
}

/** Forget one point's draft, leaving every other point untouched. */
export function clearDraft(drafts: DraftsByPoint, pointId: string): DraftsByPoint {
  if (!(pointId in drafts)) return drafts;

  const next = { ...drafts };
  delete next[pointId];
  return next;
}

/** Point ids with a draft in progress, for marking them in the picker. */
export function startedPointIds(drafts: DraftsByPoint): readonly string[] {
  return Object.keys(drafts);
}
