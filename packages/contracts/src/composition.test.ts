/**
 * Body composition contracts.
 *
 * These schemas are the only thing standing between a typo on a phone and a
 * number that silently poisons every trend computed from it, so the rules they
 * encode are worth asserting directly rather than only through a route.
 */

import { describe, expect, it } from 'vitest';

import {
  CIRCUMFERENCE_BOUNDS,
  compositionSessionSchema,
  lengthUnitSchema,
  metricHistoryEntrySchema,
  recordMeasurementSchema,
  recordMeasurementsSchema,
} from './index.js';

describe('lengthUnitSchema', () => {
  it('accepts only the two tape units', () => {
    expect(lengthUnitSchema.parse('cm')).toBe('cm');
    expect(lengthUnitSchema.parse('in')).toBe('in');
    expect(lengthUnitSchema.safeParse('metric').success).toBe(false);
    expect(lengthUnitSchema.safeParse('mm').success).toBe(false);
  });
});

describe('recordMeasurementSchema', () => {
  it('carries what the athlete typed, not a pre-converted figure', () => {
    const parsed = recordMeasurementSchema.parse({
      pointCode: 'waist',
      value: 34,
      unit: 'in',
    });

    // The auditable fact stays on the wire; the server does the conversion.
    expect(parsed).toMatchObject({ pointCode: 'waist', value: 34, unit: 'in' });
    expect(parsed).not.toHaveProperty('valueCm');
  });

  it('defaults to centimetres', () => {
    expect(recordMeasurementSchema.parse({ pointCode: 'waist', value: 86.4 }).unit).toBe('cm');
  });

  it('rejects a value that is not a measurement', () => {
    for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(recordMeasurementSchema.safeParse({ pointCode: 'waist', value }).success).toBe(false);
    }
  });

  it('catches a decimal point in the wrong place', () => {
    // 864 cm is not a waist; 86.4 is.
    expect(
      recordMeasurementSchema.safeParse({ pointCode: 'waist', value: 864, unit: 'cm' }).success,
    ).toBe(false);
    expect(
      recordMeasurementSchema.safeParse({ pointCode: 'waist', value: 86.4, unit: 'cm' }).success,
    ).toBe(true);
  });

  it('applies the bound that belongs to the unit given', () => {
    // 200 is an outsized but conceivable circumference in centimetres, and
    // 200 inches is five metres round.
    expect(
      recordMeasurementSchema.safeParse({ pointCode: 'waist', value: 200, unit: 'cm' }).success,
    ).toBe(true);
    expect(
      recordMeasurementSchema.safeParse({ pointCode: 'waist', value: 200, unit: 'in' }).success,
    ).toBe(false);

    // The two bounds describe the same physical range, so the inch numbers are
    // necessarily the smaller ones.
    expect(CIRCUMFERENCE_BOUNDS.in.max).toBeLessThan(CIRCUMFERENCE_BOUNDS.cm.max);
    expect(CIRCUMFERENCE_BOUNDS.in.max * 2.54).toBeCloseTo(CIRCUMFERENCE_BOUNDS.cm.max, 0);
  });

  it('says which range it wanted', () => {
    const result = recordMeasurementSchema.safeParse({
      pointCode: 'waist',
      value: 864,
      unit: 'cm',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('300');
    expect(result.error?.issues[0]?.path).toEqual(['value']);
  });

  it('requires a measure point', () => {
    expect(recordMeasurementSchema.safeParse({ pointCode: '', value: 86.4 }).success).toBe(false);
    expect(recordMeasurementSchema.safeParse({ value: 86.4 }).success).toBe(false);
  });

  it('leaves capturedAt optional so a correction does not restamp the reading', () => {
    expect(
      recordMeasurementSchema.parse({ pointCode: 'waist', value: 86.4 }).capturedAt,
    ).toBeUndefined();
  });
});

describe('recordMeasurementsSchema', () => {
  it('accepts a whole session in one payload', () => {
    const parsed = recordMeasurementsSchema.parse({
      measurements: [
        { pointCode: 'waist', value: 86.4 },
        { pointCode: 'chest', value: 99.2 },
      ],
    });

    expect(parsed.measurements).toHaveLength(2);
  });

  it('refuses the same point twice', () => {
    const result = recordMeasurementsSchema.safeParse({
      measurements: [
        { pointCode: 'waist', value: 86.4 },
        { pointCode: 'waist', value: 85.1 },
      ],
    });

    // No correct interpretation exists; keeping the last would hide a client
    // bug behind plausible-looking data.
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('waist');
  });

  it('refuses an empty payload', () => {
    expect(recordMeasurementsSchema.safeParse({ measurements: [] }).success).toBe(false);
  });
});

describe('metricHistoryEntrySchema', () => {
  it('keeps "no earlier session" distinct from "no change"', () => {
    const base = {
      sessionId: 's-1',
      capturedAt: '2026-09-06T07:45:00.000Z',
      localDate: '2026-09-06',
      valueCm: 86.4,
      recordedUnit: 'cm' as const,
    };

    expect(metricHistoryEntrySchema.parse(base).changeCm).toBeUndefined();
    expect(metricHistoryEntrySchema.parse({ ...base, changeCm: 0 }).changeCm).toBe(0);
    expect(metricHistoryEntrySchema.parse({ ...base, changeCm: -1.1 }).changeCm).toBe(-1.1);
  });
});

describe('compositionSessionSchema', () => {
  it('describes a session as photos and measurements together', () => {
    const parsed = compositionSessionSchema.parse({
      id: 's-1',
      capturedAt: '2026-09-06T07:45:00.000Z',
      localDate: '2026-09-06',
      photos: [],
      measurements: [],
    });

    expect(parsed.photos).toEqual([]);
    expect(parsed.measurements).toEqual([]);
  });

  it('will not accept a session missing either half', () => {
    const base = {
      id: 's-1',
      capturedAt: '2026-09-06T07:45:00.000Z',
      localDate: '2026-09-06',
    };

    expect(compositionSessionSchema.safeParse({ ...base, photos: [] }).success).toBe(false);
    expect(compositionSessionSchema.safeParse({ ...base, measurements: [] }).success).toBe(false);
  });
});
