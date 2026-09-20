import { describe, expect, it } from 'vitest';

import {
  NAVY_COEFFICIENTS,
  TAPE_REPEATABILITY_CM,
  YMCA_COEFFICIENTS,
  YMCA_STANDARD_ERROR,
  availableCircumferenceMethods,
  changeDirection,
  estimateBodyFat,
  estimateBodyFatYmca,
  isMeaningfulChange,
  NAVY_STANDARD_ERROR,
  estimateBodyFatNavy,
  netChangeCm,
  withChanges,
} from './composition.js';

const reading = (capturedAt: string, valueCm: number) => ({ capturedAt, valueCm });

describe('withChanges', () => {
  it('orders newest first whatever order it was given', () => {
    const result = withChanges([
      reading('2026-06-01T08:00:00.000Z', 88),
      reading('2026-08-01T08:00:00.000Z', 85),
      reading('2026-07-01T08:00:00.000Z', 87),
    ]);

    expect(result.map((r) => r.valueCm)).toEqual([85, 87, 88]);
  });

  it('attaches each reading change from the one before it', () => {
    const result = withChanges([
      reading('2026-06-01T08:00:00.000Z', 88),
      reading('2026-07-01T08:00:00.000Z', 87),
      reading('2026-08-01T08:00:00.000Z', 85),
    ]);

    expect(result[0]?.changeCm).toBeCloseTo(-2, 10);
    expect(result[1]?.changeCm).toBeCloseTo(-1, 10);
  });

  it('leaves the oldest without a change rather than calling it zero', () => {
    const result = withChanges([
      reading('2026-06-01T08:00:00.000Z', 88),
      reading('2026-07-01T08:00:00.000Z', 88),
    ]);

    // A genuine no-change reads as 0 ...
    expect(result[0]?.changeCm).toBe(0);
    // ... and "nothing to compare to" stays absent.
    expect(result[1]?.changeCm).toBeUndefined();
    expect('changeCm' in result[1]!).toBe(false);
  });

  it('gives the oldest row on a page its change from the row behind the page', () => {
    const page = [reading('2026-08-01T08:00:00.000Z', 85), reading('2026-07-01T08:00:00.000Z', 87)];

    // Without the extra row a value's delta would appear or vanish depending
    // on where the page boundary fell.
    const result = withChanges(page, reading('2026-06-01T08:00:00.000Z', 88));

    expect(result[1]?.changeCm).toBeCloseTo(-1, 10);
  });

  it('prefers a real neighbour over the supplied one', () => {
    const result = withChanges(
      [reading('2026-08-01T08:00:00.000Z', 85), reading('2026-07-01T08:00:00.000Z', 87)],
      reading('2026-01-01T08:00:00.000Z', 100),
    );

    expect(result[0]?.changeCm).toBeCloseTo(-2, 10);
  });

  it('carries the caller extra fields through untouched', () => {
    const result = withChanges([
      { ...reading('2026-08-01T08:00:00.000Z', 85), sessionId: 's-1', recordedUnit: 'in' },
    ]);

    expect(result[0]).toMatchObject({ sessionId: 's-1', recordedUnit: 'in' });
  });

  it('handles the empty and single cases', () => {
    expect(withChanges([])).toEqual([]);

    const single = withChanges([reading('2026-08-01T08:00:00.000Z', 85)]);
    expect(single).toHaveLength(1);
    expect(single[0]?.changeCm).toBeUndefined();
  });

  it('does not mutate the array it was given', () => {
    const input = [
      reading('2026-06-01T08:00:00.000Z', 88),
      reading('2026-08-01T08:00:00.000Z', 85),
    ];
    withChanges(input);

    expect(input.map((r) => r.valueCm)).toEqual([88, 85]);
  });
});

describe('netChangeCm', () => {
  it('measures oldest to newest regardless of input order', () => {
    expect(
      netChangeCm([
        reading('2026-08-01T08:00:00.000Z', 85),
        reading('2026-06-01T08:00:00.000Z', 88),
      ]),
    ).toBeCloseTo(-3, 10);
  });

  it('refuses to call a single reading a direction', () => {
    // One measurement is a position, not a trend.
    expect(netChangeCm([reading('2026-08-01T08:00:00.000Z', 85)])).toBeUndefined();
    expect(netChangeCm([])).toBeUndefined();
  });
});

describe('estimateBodyFatNavy', () => {
  // A worked example, computed from the published metric equation:
  //   495 / (1.0324 − 0.19077·log10(86.4 − 38.1) + 0.15456·log10(178)) − 450
  const MALE = { variant: 'male' as const, waistCm: 86.4, neckCm: 38.1, heightCm: 178 };
  const FEMALE = {
    variant: 'female' as const,
    waistCm: 74.5,
    neckCm: 32.5,
    hipsCm: 97.0,
    heightCm: 165,
  };

  function expectedMale(): number {
    const girth = MALE.waistCm - MALE.neckCm;
    const c = NAVY_COEFFICIENTS.male;
    const denominator =
      c.intercept - c.girth * Math.log10(girth) + c.height * Math.log10(MALE.heightCm);
    return 495 / denominator - 450;
  }

  it('matches the published equation', () => {
    const result = estimateBodyFatNavy(MALE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const raw = result.steps.at(-1)!.value;
    expect(raw).toBeCloseTo(expectedMale(), 1);
  });

  it('produces a figure in a believable region for those inputs', () => {
    const result = estimateBodyFatNavy(MALE);
    if (!result.ok) throw new Error('expected a result');

    // Sanity anchor rather than a restatement of the arithmetic above: an
    // 86 cm waist on a 178 cm frame is not 4% and not 40%.
    expect(result.steps.at(-1)!.value).toBeGreaterThan(10);
    expect(result.steps.at(-1)!.value).toBeLessThan(25);
  });

  it('reports a band, never a single figure', () => {
    const result = estimateBodyFatNavy(MALE);
    if (!result.ok) throw new Error('expected a result');

    const raw = result.steps.at(-1)!.value;
    expect(result.valueLow).toBeCloseTo(raw - NAVY_STANDARD_ERROR, 1);
    expect(result.valueHigh).toBeCloseTo(raw + NAVY_STANDARD_ERROR, 1);
    expect(result.valueHigh - result.valueLow).toBeCloseTo(2 * NAVY_STANDARD_ERROR, 1);
  });

  it('shows every step that produced the answer', () => {
    const result = estimateBodyFatNavy(MALE);
    if (!result.ok) throw new Error('expected a result');

    // The steps are the feature, not a debug aid: an estimate an athlete
    // cannot inspect is a number they have to take on trust.
    expect(result.steps.map((step) => step.label)).toEqual([
      'Waist minus neck',
      'Log of that girth',
      'Log of height',
      'Denominator',
      'Body fat from the equation',
    ]);
    for (const step of result.steps) {
      expect(step.expression.length).toBeGreaterThan(0);
      expect(Number.isFinite(step.value)).toBe(true);
    }
  });

  it('reads the hips on the female variant and not on the male one', () => {
    const withHips = estimateBodyFatNavy(FEMALE);
    if (!withHips.ok) throw new Error('expected a result');
    expect(withHips.steps[0]?.label).toBe('Waist plus hips, minus neck');
    expect(withHips.steps[0]?.value).toBeCloseTo(FEMALE.waistCm + FEMALE.hipsCm - FEMALE.neckCm, 1);

    // Hips supplied to the male variant change nothing.
    const maleWithHips = estimateBodyFatNavy({ ...MALE, hipsCm: 99 });
    if (!maleWithHips.ok) throw new Error('expected a result');
    expect(maleWithHips.valueLow).toBe(
      (estimateBodyFatNavy(MALE) as { valueLow: number }).valueLow,
    );
  });

  it('refuses to run without the hips on the female variant', () => {
    const result = estimateBodyFatNavy({ ...FEMALE, hipsCm: undefined });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('hips');
  });

  it('names a missing or unusable measurement', () => {
    for (const [field, value] of [
      ['waistCm', 0],
      ['neckCm', Number.NaN],
      ['heightCm', -1],
    ] as const) {
      const result = estimateBodyFatNavy({ ...MALE, [field]: value });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toMatch(/waist|neck|height/);
    }
  });

  it('refuses rather than returning NaN when the girth is not positive', () => {
    // A neck larger than the waist would take log10 of a negative number, and
    // a NaN percentage on screen is worse than a plain refusal.
    const result = estimateBodyFatNavy({ ...MALE, waistCm: 38, neckCm: 40 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('girth');
    // The step that failed is still reported, so the problem is locatable.
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.label).toBe('Waist minus neck');
  });

  it('refuses a result outside any plausible range', () => {
    // A 40 cm waist on a 250 cm frame is not a person; the equation still
    // produces a number, and it should not be shown.
    const result = estimateBodyFatNavy({
      variant: 'male',
      waistCm: 200,
      neckCm: 30,
      heightCm: 120,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('plausible');
  });

  it('keeps the band inside the plausible range it enforces', () => {
    const result = estimateBodyFatNavy({
      variant: 'male',
      waistCm: 70,
      neckCm: 42,
      heightCm: 190,
    });

    if (!result.ok) return;
    expect(result.valueLow).toBeGreaterThanOrEqual(2);
    expect(result.valueHigh).toBeLessThanOrEqual(70);
  });

  it('is deterministic', () => {
    expect(estimateBodyFatNavy(MALE)).toEqual(estimateBodyFatNavy(MALE));
  });
});

describe('changeDirection', () => {
  it('reports a real move in the direction it went', () => {
    expect(changeDirection(-2.9)).toBe('down');
    expect(changeDirection(0.8)).toBe('up');
  });

  it('calls anything inside the tape noise steady', () => {
    // A difference smaller than the tape can resolve is the same measurement
    // taken twice, not progress.
    expect(changeDirection(0.2)).toBe('steady');
    expect(changeDirection(-0.4)).toBe('steady');
    expect(changeDirection(0)).toBe('steady');
  });

  it('treats the threshold itself as a real change', () => {
    expect(changeDirection(TAPE_REPEATABILITY_CM)).toBe('up');
    expect(changeDirection(-TAPE_REPEATABILITY_CM)).toBe('down');
  });

  it('takes a caller threshold for a site that repeats differently', () => {
    expect(changeDirection(0.8, 1.0)).toBe('steady');
    expect(changeDirection(0.8, 0.5)).toBe('up');
  });

  it('does not call a non-finite delta a direction', () => {
    expect(changeDirection(Number.NaN)).toBe('steady');
  });

  it('has a companion predicate that agrees with it', () => {
    for (const delta of [-3, -0.6, -0.4, 0, 0.4, 0.6, 3]) {
      expect(isMeaningfulChange(delta)).toBe(changeDirection(delta) !== 'steady');
    }
  });
});

describe('estimateBodyFatYmca', () => {
  const MALE = { variant: 'male' as const, waistCm: 86.4, weightKg: 75 };

  function expectedMale(): number {
    const waistIn = MALE.waistCm / 2.54;
    const weightLb = MALE.weightKg / 0.45359237;
    const numerator = YMCA_COEFFICIENTS.male.intercept + 4.15 * waistIn - 0.082 * weightLb;
    return (numerator / weightLb) * 100;
  }

  it('matches the published equation', () => {
    const result = estimateBodyFatYmca(MALE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.steps.at(-1)!.value).toBeCloseTo(expectedMale(), 1);
  });

  it('lands in a believable region for those inputs', () => {
    const result = estimateBodyFatYmca(MALE);
    if (!result.ok) throw new Error('expected a result');

    expect(result.steps.at(-1)!.value).toBeGreaterThan(10);
    expect(result.steps.at(-1)!.value).toBeLessThan(30);
  });

  it('converts to the units the equation is published in, and shows it', () => {
    const result = estimateBodyFatYmca(MALE);
    if (!result.ok) throw new Error('expected a result');

    // Converting here rather than rewriting the constants keeps them
    // checkable against the source.
    expect(result.steps[0]?.unit).toBe('in');
    expect(result.steps[0]?.value).toBeCloseTo(34.02, 1);
    expect(result.steps[1]?.unit).toBe('lb');
    expect(result.steps[1]?.value).toBeCloseTo(165.3, 0);
  });

  it('uses a different intercept per coefficient set', () => {
    const male = estimateBodyFatYmca(MALE);
    const female = estimateBodyFatYmca({ ...MALE, variant: 'female' });

    if (!male.ok || !female.ok) throw new Error('expected results');
    expect(female.steps.at(-1)!.value).not.toBeCloseTo(male.steps.at(-1)!.value, 1);
    expect(YMCA_COEFFICIENTS.female.intercept).not.toBe(YMCA_COEFFICIENTS.male.intercept);
  });

  it('reports a wider band than the Navy equation', () => {
    // It reads two measurements rather than three and carries no height term,
    // so it has less to go on and its band should say so.
    expect(YMCA_STANDARD_ERROR).toBeGreaterThan(NAVY_STANDARD_ERROR);
  });

  it('names a missing measurement', () => {
    for (const [field, value] of [
      ['waistCm', 0],
      ['weightKg', Number.NaN],
    ] as const) {
      const result = estimateBodyFatYmca({ ...MALE, [field]: value });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toMatch(/waist|weight/);
    }
  });

  it('refuses a result outside any plausible range', () => {
    const result = estimateBodyFatYmca({ variant: 'male', waistCm: 200, weightKg: 45 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('plausible');
  });
});

describe('availableCircumferenceMethods', () => {
  const FULL = {
    variant: 'male' as const,
    waistCm: 86.4,
    neckCm: 38.1,
    heightCm: 178,
    weightKg: 75,
  };

  it('prefers the equation that reads more', () => {
    expect(availableCircumferenceMethods(FULL)).toEqual(['navy', 'ymca']);
  });

  it('offers YMCA when there is a weight but no neck', () => {
    const { neckCm: _neck, ...withoutNeck } = FULL;
    expect(availableCircumferenceMethods(withoutNeck)).toEqual(['ymca']);
  });

  it('offers Navy when there is a neck and height but no scale', () => {
    const { weightKg: _weight, ...withoutWeight } = FULL;
    expect(availableCircumferenceMethods(withoutWeight)).toEqual(['navy']);
  });

  it('requires hips for the female coefficient set', () => {
    const { weightKg: _weight, ...navyOnly } = FULL;
    expect(availableCircumferenceMethods({ ...navyOnly, variant: 'female' })).toEqual([]);
    expect(availableCircumferenceMethods({ ...navyOnly, variant: 'female', hipsCm: 97 })).toEqual([
      'navy',
    ]);
  });

  it('offers nothing without a waist', () => {
    expect(availableCircumferenceMethods({ ...FULL, waistCm: 0 })).toEqual([]);
  });
});

describe('estimateBodyFat', () => {
  const FULL = {
    variant: 'male' as const,
    waistCm: 86.4,
    neckCm: 38.1,
    heightCm: 178,
    weightKg: 75,
  };

  it('dispatches to the named method', () => {
    const navy = estimateBodyFat('navy', FULL);
    const ymca = estimateBodyFat('ymca', FULL);

    if (!navy.ok || !ymca.ok) throw new Error('expected results');
    // Two equations reading different measurements land in different places.
    expect(navy.standardError).toBe(NAVY_STANDARD_ERROR);
    expect(ymca.standardError).toBe(YMCA_STANDARD_ERROR);
  });

  it('gives both methods the same result shape', () => {
    const navy = estimateBodyFat('navy', FULL);
    const ymca = estimateBodyFat('ymca', FULL);

    expect(Object.keys(navy).sort()).toEqual(Object.keys(ymca).sort());
  });

  it('fails cleanly when the named method lacks its inputs', () => {
    const { weightKg: _w, ...noWeight } = FULL;
    const result = estimateBodyFat('ymca', noWeight);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('weight');
  });
});
