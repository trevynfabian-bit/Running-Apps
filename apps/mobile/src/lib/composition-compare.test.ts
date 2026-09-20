/**
 * The case worth designing against: a point measured in one session and not
 * the other must never read as a change of zero.
 */

import { describe, expect, it } from 'vitest';

import { STUB_CIRCUMFERENCE_POINTS } from './body-composition';
import type { BodyCompositionSession } from './composition-session';
import {
  comparableRows,
  compareSessions,
  daysBetween,
  netChangeForPoint,
  orderSessions,
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
