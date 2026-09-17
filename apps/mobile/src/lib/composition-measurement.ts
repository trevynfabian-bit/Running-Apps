/**
 * Tape guidance and input parsing for circumference measurements.
 *
 * Where to put the tape is the whole game. A waist measured at the navel one
 * month and at the narrowest point the next produces a trend that is entirely
 * an artefact of where the tape went, and the athlete has no way to tell that
 * from a real change. So each point names one place and one tension, and says
 * it the same way every time.
 *
 * Copy lives here rather than in `@running/core`, which holds the codes and
 * knows nothing about wording.
 */

import { type CircumferencePointCode, type MeasurementUnit } from '@running/core';

export const TAPE_GUIDANCE: Readonly<Record<CircumferencePointCode, string>> = {
  neck: 'Just below the larynx, tape sloping slightly down at the front.',
  chest:
    'Around the fullest part, tape level all the way round, at the end of a normal breath out.',
  waist: 'At the navel, not the narrowest point. Standing relaxed, not holding it in.',
  hips: 'Around the widest part of the buttocks, feet together.',
  left_arm: 'Midway between shoulder and elbow, arm hanging relaxed at your side.',
  right_arm: 'Midway between shoulder and elbow, arm hanging relaxed at your side.',
  left_thigh: 'Midway between hip and knee, weight even on both feet.',
  right_thigh: 'Midway between hip and knee, weight even on both feet.',
};

export const UNIT_LABELS: Readonly<Record<MeasurementUnit, string>> = {
  cm: 'cm',
  in: 'in',
};

/**
 * Read a typed value.
 *
 * Accepts a comma as the decimal separator, because a phone keypad in much of
 * the world produces one and rejecting it looks like the app is broken.
 * Returns `undefined` for anything that is not a number, which the caller shows
 * as "not entered" rather than as an error while the athlete is mid-type.
 */
export function parseMeasurementInput(raw: string): number | undefined {
  const trimmed = raw.trim().replace(',', '.');
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/** One decimal place: a tape does not resolve finer, and more digits imply it does. */
export function formatMeasurement(value: number): string {
  return value.toFixed(1);
}
