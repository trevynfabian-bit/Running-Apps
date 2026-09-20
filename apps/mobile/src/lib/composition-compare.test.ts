/**
 * The case worth designing against: a point measured in one session and not
 * the other must never read as a change of zero.
 */

import { describe, expect, it } from 'vitest';

import { STUB_CIRCUMFERENCE_POINTS } from './body-composition';
import type { BodyCompositionSession } from './composition-session';
import {
  RANGE_PRESETS,
  comparablePhotoCount,
  comparableRows,
  comparePhotos,
  compareSessions,
  daysBetween,
  netChangeForPoint,
  orderSessions,
  resolveRange,
  selectSlot,
  sessionsInRange,
  totalChangeCm,
} from './composition-compare';

const WAIST = 'point-waist';
const CHEST = 'point-chest';
const THIGH = 'point-thigh';

function session(
  id: string,
  capturedAt: string,
  values: Record<string, number>,
): BodyCompositionSession {
  return {
    id,
    capturedAt,
    measurements: Object.entries(values).map(([pointId, valueCm], index) => ({
      id: `${id}-${index}`,
      pointId,
      valueCm,
      recordedUnit: 'cm',
      capturedAt,
    })),
  };
}

const JUNE = session('june', '2026-06-14T07:30:00.000Z', {
  [WAIST]: 88.2,
  [CHEST]: 99.0,
  [THIGH]: 56.0,
});
const SEPTEMBER = session('september', '2026-09-06T07:45:00.000Z', {
  [WAIST]: 85.3,
  [CHEST]: 99.8,
});

describe('orderSessions', () => {
  it('puts the earlier session first whichever order it was given', () => {
    // Which one the athlete tapped first says nothing about which came first.
    expect(orderSessions(JUNE, SEPTEMBER).earlier.id).toBe('june');
    expect(orderSessions(SEPTEMBER, JUNE).earlier.id).toBe('june');
    expect(orderSessions(SEPTEMBER, JUNE).later.id).toBe('september');
  });
});

describe('daysBetween', () => {
  it('counts whole days, in either direction', () => {
    expect(daysBetween('2026-06-14T07:30:00.000Z', '2026-06-24T07:30:00.000Z')).toBe(10);
    expect(daysBetween('2026-06-24T07:30:00.000Z', '2026-06-14T07:30:00.000Z')).toBe(10);
  });

  it('is zero for the same instant, and never negative', () => {
    expect(daysBetween('2026-06-14T07:30:00.000Z', '2026-06-14T07:30:00.000Z')).toBe(0);
    expect(daysBetween('nonsense', '2026-06-14T07:30:00.000Z')).toBe(0);
  });
});

describe('compareSessions', () => {
  it('reports a change where both sessions measured', () => {
    const comparison = compareSessions(JUNE, SEPTEMBER);
    const waist = comparison.rows.find((row) => row.point.id === WAIST);

    expect(waist?.fromCm).toBeCloseTo(88.2, 6);
    expect(waist?.toCm).toBeCloseTo(85.3, 6);
    expect(waist?.changeCm).toBeCloseTo(-2.9, 6);
  });

  it('leaves a half-measured point without a change', () => {
    const comparison = compareSessions(JUNE, SEPTEMBER);
    const thigh = comparison.rows.find((row) => row.point.id === THIGH);

    // September skipped the thigh. Reading "0.0 cm" would say three months of
    // nothing happened.
    expect(thigh?.fromCm).toBeCloseTo(56, 6);
    expect(thigh?.toCm).toBeUndefined();
    expect(thigh?.changeCm).toBeUndefined();
    expect('changeCm' in thigh!).toBe(false);
  });

  it('includes points neither session measured, as empty rows', () => {
    const comparison = compareSessions(JUNE, SEPTEMBER);
    const neck = comparison.rows.find((row) => row.point.code === 'neck');

    expect(neck?.fromCm).toBeUndefined();
    expect(neck?.toCm).toBeUndefined();
    expect(comparison.rows).toHaveLength(STUB_CIRCUMFERENCE_POINTS.length);
  });

  it('orders rows anatomically, not by when they were recorded', () => {
    const comparison = compareSessions(SEPTEMBER, JUNE);
    const order = comparison.rows.map((row) => row.point.sortOrder);

    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('puts the sessions in time order whichever way they were passed', () => {
    expect(compareSessions(SEPTEMBER, JUNE).earlier.id).toBe('june');
    expect(compareSessions(JUNE, SEPTEMBER).later.id).toBe('september');
  });

  it('counts what it can actually compare', () => {
    const comparison = compareSessions(JUNE, SEPTEMBER);

    // Waist and chest; not the thigh, and not the untouched points.
    expect(comparison.comparableCount).toBe(2);
    expect(
      comparableRows(comparison)
        .map((row) => row.point.code)
        .sort(),
    ).toEqual(['chest', 'waist']);
  });

  it('reports how far apart the sessions are', () => {
    expect(compareSessions(JUNE, SEPTEMBER).daysApart).toBe(84);
  });

  it('keeps the unit the later reading was taken in', () => {
    const inInches = session('inches', '2026-10-01T07:30:00.000Z', { [WAIST]: 84 });
    inInches.measurements = inInches.measurements.map((m) => ({ ...m, recordedUnit: 'in' }));

    expect(
      compareSessions(JUNE, inInches).rows.find((r) => r.point.id === WAIST)?.recordedUnit,
    ).toBe('in');
  });
});

describe('totalChangeCm', () => {
  it('sums every comparable change', () => {
    // Waist −2.9, chest +0.8.
    expect(totalChangeCm(compareSessions(JUNE, SEPTEMBER))).toBeCloseTo(-2.1, 6);
  });

  it('refuses to total a comparison with nothing in common', () => {
    const onlyThigh = session('thigh-only', '2026-10-01T07:30:00.000Z', { [THIGH]: 55 });
    const onlyWaist = session('waist-only', '2026-11-01T07:30:00.000Z', { [WAIST]: 85 });

    // Zero would suggest it found nothing rather than that it could not look.
    expect(totalChangeCm(compareSessions(onlyThigh, onlyWaist))).toBeUndefined();
  });
});

describe('netChangeForPoint', () => {
  it('measures across a run of sessions, oldest to newest', () => {
    const middle = session('july', '2026-07-12T07:15:00.000Z', { [WAIST]: 87.1 });

    expect(netChangeForPoint([SEPTEMBER, JUNE, middle], WAIST)).toBeCloseTo(-2.9, 6);
  });

  it('refuses to call a single session a direction', () => {
    expect(netChangeForPoint([JUNE], WAIST)).toBeUndefined();
    expect(netChangeForPoint([], WAIST)).toBeUndefined();
  });

  it('ignores sessions that did not measure the point', () => {
    // Only June has a thigh value, so there is no direction to report.
    expect(netChangeForPoint([JUNE, SEPTEMBER], THIGH)).toBeUndefined();
  });
});

describe('choosing a range', () => {
  const NOW = new Date('2026-09-20T12:00:00.000Z');

  // 14, 70, 98 and 190 days before NOW respectively.
  const RECENT = session('recent', '2026-09-06T07:45:00.000Z', { [WAIST]: 85.3 });
  const SUMMER = session('summer', '2026-07-12T07:15:00.000Z', { [WAIST]: 87.1 });
  const SPRING = session('spring', '2026-06-14T07:30:00.000Z', { [WAIST]: 88.2 });
  const WINTER = session('winter', '2026-03-14T07:30:00.000Z', { [WAIST]: 91.0 });
  const ALL = [SUMMER, WINTER, RECENT, SPRING];

  it('offers no window short enough to show mostly noise', () => {
    // Composition changes on a scale of months; a two-week window would
    // invite reading measurement noise as progress.
    const shortest = Math.min(...RANGE_PRESETS.map((p) => p.days ?? Infinity));
    expect(shortest).toBeGreaterThanOrEqual(42);
    expect(RANGE_PRESETS.some((p) => p.days === undefined)).toBe(true);
  });

  it('returns sessions inside the window, newest first', () => {
    // 91 days back from NOW reaches 21 June, so spring (14 June) is outside.
    expect(sessionsInRange(ALL, 91, NOW).map((s) => s.id)).toEqual(['recent', 'summer']);
    expect(sessionsInRange(ALL, 182, NOW).map((s) => s.id)).toEqual(['recent', 'summer', 'spring']);
  });

  it('excludes a session that falls just outside the window', () => {
    // Spring is 98 days back: inside six months, outside three.
    expect(sessionsInRange(ALL, 91, NOW).some((s) => s.id === 'spring')).toBe(false);
    expect(sessionsInRange(ALL, 182, NOW).some((s) => s.id === 'spring')).toBe(true);
  });

  it('returns everything when the window is all time', () => {
    expect(sessionsInRange(ALL, undefined, NOW)).toHaveLength(4);
  });

  it('resolves a range to its widest pair, not its two newest', () => {
    // Six months holds three sessions; the pair is the span, not the two
    // most recent that happen to fall inside.
    const resolved = resolveRange(ALL, 182, NOW);

    expect(resolved?.earlier.id).toBe('spring');
    expect(resolved?.later.id).toBe('recent');
    expect(resolved?.later.id).not.toBe('summer');
  });

  it('refuses a window holding fewer than two sessions', () => {
    // One session is not a comparison, and widening the range to find a
    // second would answer a question the athlete did not ask.
    expect(resolveRange(ALL, 42, NOW)).toBeUndefined();
    expect(resolveRange([], undefined, NOW)).toBeUndefined();
    expect(resolveRange([RECENT], undefined, NOW)).toBeUndefined();
  });

  it('handles an unordered input list', () => {
    const shuffled = [WINTER, RECENT, SPRING, SUMMER];
    expect(resolveRange(shuffled, undefined, NOW)?.earlier.id).toBe('winter');
  });
});

describe('selectSlot', () => {
  const current = { earlierId: 'june', laterId: 'september' };

  it('sets the slot that was tapped', () => {
    expect(selectSlot(current, 'earlier', 'march')).toEqual({
      earlierId: 'march',
      laterId: 'september',
    });
    expect(selectSlot(current, 'later', 'october')).toEqual({
      earlierId: 'june',
      laterId: 'october',
    });
  });

  it('swaps rather than putting one session on both sides', () => {
    // A session compared against itself produces a column of zeroes, which
    // looks like a finding and is not one.
    expect(selectSlot(current, 'earlier', 'september')).toEqual({
      earlierId: 'september',
      laterId: 'june',
    });
    expect(selectSlot(current, 'later', 'june')).toEqual({
      earlierId: 'september',
      laterId: 'june',
    });
  });

  it('is a no-op when the slot already holds that session', () => {
    expect(selectSlot(current, 'earlier', 'june')).toEqual(current);
  });
});

describe('comparePhotos', () => {
  function withPhotos(
    base: BodyCompositionSession,
    sides: readonly ('front' | 'back' | 'left' | 'right')[],
  ): BodyCompositionSession {
    return {
      ...base,
      photos: sides.map((side) => ({
        id: `${base.id}-${side}`,
        side,
        capturedAt: base.capturedAt,
      })),
    };
  }

  it('returns all four sides in a fixed order', () => {
    const pairs = comparePhotos(undefined, undefined);

    expect(pairs.map((pair) => pair.side)).toEqual(['front', 'back', 'left', 'right']);
  });

  it('pairs a side present in both sessions', () => {
    const pairs = comparePhotos(
      withPhotos(JUNE, ['front', 'back', 'left', 'right']),
      withPhotos(SEPTEMBER, ['front', 'back', 'left', 'right']),
    );

    expect(pairs.every((pair) => pair.comparable)).toBe(true);
    expect(comparablePhotoCount(pairs)).toBe(4);
  });

  it('keeps a side only one session has, and marks it not comparable', () => {
    const pairs = comparePhotos(
      withPhotos(JUNE, ['front', 'back', 'left', 'right']),
      withPhotos(SEPTEMBER, ['front']),
    );

    const back = pairs.find((pair) => pair.side === 'back');
    // Dropping it would make a half-photographed session look complete.
    expect(back?.earlier).toBeDefined();
    expect(back?.later).toBeUndefined();
    expect(back?.comparable).toBe(false);
    expect(comparablePhotoCount(pairs)).toBe(1);
  });

  it('copes with a session that was never photographed', () => {
    const pairs = comparePhotos(JUNE, withPhotos(SEPTEMBER, ['front', 'back', 'left', 'right']));

    expect(pairs).toHaveLength(4);
    expect(comparablePhotoCount(pairs)).toBe(0);
    expect(pairs.every((pair) => pair.earlier === undefined)).toBe(true);
    expect(pairs.every((pair) => pair.later !== undefined)).toBe(true);
  });
});
