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
  changeDirectionSchema,
  compareSessionsQuerySchema,
  comparisonRowSchema,
  comparisonSummarySchema,
  compositionInventorySchema,
  deletionReceiptSchema,
  photoPairSchema,
  purgeCompositionSchema,
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

describe('comparisonRowSchema', () => {
  const base = { pointCode: 'waist', pointLabel: 'Waist' };

  it('accepts a point measured in both sessions', () => {
    const parsed = comparisonRowSchema.parse({
      ...base,
      fromCm: 88.2,
      toCm: 85.3,
      changeCm: -2.9,
      direction: 'down',
    });

    expect(parsed.changeCm).toBeCloseTo(-2.9, 6);
    expect(parsed.direction).toBe('down');
  });

  it('accepts a point measured in only one, with no change at all', () => {
    const parsed = comparisonRowSchema.parse({ ...base, fromCm: 56 });

    // Never a change of zero: that would read as three months of nothing.
    expect(parsed.changeCm).toBeUndefined();
    expect(parsed.direction).toBeUndefined();
  });

  it('accepts a point neither session measured', () => {
    expect(comparisonRowSchema.parse(base).fromCm).toBeUndefined();
  });

  it('keeps steady distinct from a missing change', () => {
    expect(changeDirectionSchema.parse('steady')).toBe('steady');
    expect(changeDirectionSchema.safeParse('unchanged').success).toBe(false);
    expect(changeDirectionSchema.safeParse('none').success).toBe(false);
  });
});

describe('comparisonSummarySchema', () => {
  it('counts rather than judging', () => {
    const parsed = comparisonSummarySchema.parse({
      movedCount: 2,
      steadyCount: 1,
      onlyOneSessionCount: 1,
      totalChangeCm: -2.1,
      thresholdCm: 0.5,
      headline: 'Over 84 days, 2 points moved and 1 held steady.',
    });

    expect(parsed.headline).not.toMatch(/good|bad|great|poor|progress/i);
    // The noise floor travels with the summary so "steady" is not a black box.
    expect(parsed.thresholdCm).toBe(0.5);
  });

  it('lets the total be absent when nothing is comparable', () => {
    const parsed = comparisonSummarySchema.parse({
      movedCount: 0,
      steadyCount: 0,
      onlyOneSessionCount: 3,
      thresholdCm: 0.5,
      headline: 'Nothing to compare.',
    });

    // Zero would suggest it found nothing rather than that it could not look.
    expect(parsed.totalChangeCm).toBeUndefined();
  });
});

describe('photoPairSchema', () => {
  it('keeps a side only one session has', () => {
    const parsed = photoPairSchema.parse({ side: 'back', comparable: false });

    // Dropping it would make a half-photographed session look complete.
    expect(parsed.earlier).toBeUndefined();
    expect(parsed.comparable).toBe(false);
  });
});

describe('compareSessionsQuerySchema', () => {
  it('accepts two ids', () => {
    expect(compareSessionsQuerySchema.safeParse({ earlierId: 'a', laterId: 'b' }).success).toBe(
      true,
    );
  });

  it('accepts a window on its own', () => {
    expect(compareSessionsQuerySchema.parse({ days: '91' }).days).toBe(91);
  });

  it('accepts neither, meaning all time', () => {
    expect(compareSessionsQuerySchema.safeParse({}).success).toBe(true);
  });

  it('refuses one id without the other', () => {
    expect(compareSessionsQuerySchema.safeParse({ earlierId: 'a' }).success).toBe(false);
    expect(compareSessionsQuerySchema.safeParse({ laterId: 'b' }).success).toBe(false);
  });

  it('refuses a session compared against itself', () => {
    // A column of zeroes looks like a finding and is not one.
    const result = compareSessionsQuerySchema.safeParse({ earlierId: 'a', laterId: 'a' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('two different');
  });

  it('refuses a window that is not a positive whole number of days', () => {
    expect(compareSessionsQuerySchema.safeParse({ days: '0' }).success).toBe(false);
    expect(compareSessionsQuerySchema.safeParse({ days: '-7' }).success).toBe(false);
    expect(compareSessionsQuerySchema.safeParse({ days: 'soon' }).success).toBe(false);
  });
});

describe('compositionInventorySchema', () => {
  it('describes what is stored in counts, not contents', () => {
    const parsed = compositionInventorySchema.parse({
      sessions: [
        {
          sessionId: 's-1',
          capturedAt: '2026-09-06T07:45:00.000Z',
          localDate: '2026-09-06',
          photoCount: 4,
          measurementCount: 6,
          estimateCount: 1,
          onServer: true,
        },
      ],
      totals: {
        sessionCount: 1,
        photoCount: 4,
        measurementCount: 6,
        estimateCount: 1,
        photoBytes: 2_400_000,
      },
    });

    // "Some of your data is stored" is not an answer; these are.
    expect(parsed.sessions[0]?.onServer).toBe(true);
    expect(parsed.totals.photoBytes).toBe(2_400_000);
    expect(parsed.sessions[0]).not.toHaveProperty('photos');
  });
});

describe('deletionReceiptSchema', () => {
  it('counts what went, rather than reporting a bare success', () => {
    const parsed = deletionReceiptSchema.parse({
      sessionsDeleted: 1,
      photosDeleted: 4,
      measurementsDeleted: 6,
      estimatesDeleted: 1,
      filesDeleted: 4,
      filesMissing: 0,
    });

    // The nearest thing to proof this API can offer for a claim the athlete
    // cannot verify.
    expect(parsed.photosDeleted).toBe(4);
    expect(parsed.filesDeleted).toBe(4);
  });

  it('has a place to report files the database expected and storage lacked', () => {
    const parsed = deletionReceiptSchema.parse({
      sessionsDeleted: 1,
      photosDeleted: 4,
      measurementsDeleted: 0,
      estimatesDeleted: 0,
      filesDeleted: 3,
      filesMissing: 1,
    });

    // Swallowing it would let the discrepancy grow unseen.
    expect(parsed.filesMissing).toBe(1);
    expect(parsed.filesDeleted).toBeLessThan(parsed.photosDeleted);
  });
});

describe('purgeCompositionSchema', () => {
  it('requires the caller to state what they intend', () => {
    expect(
      purgeCompositionSchema.safeParse({ confirm: 'delete my composition data' }).success,
    ).toBe(true);
  });

  it('refuses anything else, including a plausible near-miss', () => {
    // A destructive endpoint with no undo should not be reachable by a
    // mistyped URL or a stray retry.
    for (const confirm of ['yes', 'true', 'delete', 'Delete my composition data', '']) {
      expect(purgeCompositionSchema.safeParse({ confirm }).success).toBe(false);
    }
    expect(purgeCompositionSchema.safeParse({}).success).toBe(false);
  });
});
