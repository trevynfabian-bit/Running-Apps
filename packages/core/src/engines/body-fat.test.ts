import { describe, expect, it } from 'vitest';
import {
  BODY_FAT_ESTIMATE_NOTE,
  aiServiceGuidance,
  estimateBodyFat,
  labelAiBodyFat,
  preferredBodyFatEstimate,
  usNavyBodyFat,
  ymcaBodyFat,
  type BodyFatEstimate,
  type BodyFatInputs,
} from './body-fat.js';

const male: BodyFatInputs = {
  sex: 'male',
  heightCm: 178,
  weightKg: 75,
  circumferencesCm: { neck: 38, waist: 85, hips: 96 },
};

const female: BodyFatInputs = {
  sex: 'female',
  heightCm: 165,
  weightKg: 58,
  circumferencesCm: { neck: 33, waist: 72, hips: 96 },
};

function expectWellFormed(estimate: BodyFatEstimate): void {
  expect(estimate.valueLow).toBeLessThan(estimate.value);
  expect(estimate.valueHigh).toBeGreaterThan(estimate.value);
  expect(estimate.valueLow).toBeGreaterThanOrEqual(0);
  expect(estimate.valueHigh).toBeLessThanOrEqual(70);
  expect(estimate.note).toBe(BODY_FAT_ESTIMATE_NOTE);
  expect(estimate.confidenceReasons.length).toBeGreaterThan(0);
}

describe('usNavyBodyFat', () => {
  it('reproduces the published male formula', () => {
    const estimate = usNavyBodyFat(male)!;
    expect(estimate.formula).toBe('us_navy');
    expect(estimate.variant).toBe('male');
    expect(estimate.value).toBeCloseTo(16.4, 0);
    expect(estimate.confidence).toBe('moderate');
    expectWellFormed(estimate);
  });

  it('reproduces the published female formula, which needs the hips', () => {
    const estimate = usNavyBodyFat(female)!;
    expect(estimate.variant).toBe('female');
    expect(estimate.value).toBeCloseTo(25.9, 0);
    expect(estimate.inputs.map((i) => i.key)).toEqual(['height', 'neck', 'waist', 'hips']);
    expectWellFormed(estimate);
  });

  it('shows every step with the numbers substituted in', () => {
    const estimate = usNavyBodyFat(male)!;
    expect(estimate.steps).toHaveLength(5);
    expect(estimate.steps[0]!.result).toBe(47);
    expect(estimate.steps[1]!.detail).toContain('log10(47.0)');
    expect(estimate.steps[4]!.result).toBe(estimate.value);
    // Inputs are reported in the unit the formula consumed them in.
    expect(estimate.inputs.every((i) => i.unit === 'cm')).toBe(true);
  });

  it('is a range around the point value, 3.5 points either way at moderate confidence', () => {
    const estimate = usNavyBodyFat(male)!;
    expect(estimate.valueHigh - estimate.valueLow).toBeCloseTo(7, 1);
  });

  it('refuses to run without its inputs', () => {
    expect(usNavyBodyFat({ sex: 'male', circumferencesCm: { waist: 85 } })).toBeUndefined();
    expect(
      usNavyBodyFat({ sex: 'female', heightCm: 165, circumferencesCm: { neck: 33, waist: 72 } }),
    ).toBeUndefined();
  });

  it('refuses a waist no larger than the neck instead of taking a bad logarithm', () => {
    const inputs = { ...male, circumferencesCm: { neck: 40, waist: 39 } };
    expect(usNavyBodyFat(inputs)).toBeUndefined();
    const assessment = estimateBodyFat(inputs);
    expect(assessment.unavailable.find((u) => u.formula === 'us_navy')?.missing[0]).toMatch(
      /larger than the neck/,
    );
  });

  it('drops to low confidence and widens the range for implausible inputs', () => {
    const estimate = usNavyBodyFat({ ...male, heightCm: 100 })!;
    expect(estimate.confidence).toBe('low');
    expect(estimate.confidenceReasons.join(' ')).toMatch(/Height is outside/);
    expect(estimate.valueHigh - estimate.valueLow).toBeCloseTo(10, 1);
  });

  it('covers both variants in one wider range when sex is unspecified', () => {
    const estimate = usNavyBodyFat({ ...male, sex: 'unspecified' })!;
    expect(estimate.variant).toBe('both');
    expect(estimate.confidence).toBe('low');
    expect(estimate.valueLow).toBeLessThan(16.4);
    expect(estimate.valueHigh).toBeGreaterThan(26.6);
    expect(estimate.confidenceReasons.join(' ')).toMatch(/Sex is not set/);
    // Both sets of working are shown.
    expect(estimate.steps.some((s) => s.label.includes('(male)'))).toBe(true);
    expect(estimate.steps.some((s) => s.label.includes('(female)'))).toBe(true);
  });

  it('falls back to the male variant when sex is unspecified and there are no hips', () => {
    const estimate = usNavyBodyFat({
      sex: 'unspecified',
      heightCm: 178,
      circumferencesCm: { neck: 38, waist: 85 },
    })!;
    expect(estimate.variant).toBe('male');
    expect(estimate.confidence).toBe('low');
    expect(estimate.confidenceReasons.join(' ')).toMatch(/male variant/);
  });
});

describe('ymcaBodyFat', () => {
  it('works in inches and pounds and shows the conversion', () => {
    const estimate = ymcaBodyFat(male)!;
    expect(estimate.formula).toBe('ymca');
    expect(estimate.value).toBeCloseTo(16.3, 0);
    expect(estimate.steps[0]!.label).toBe('Waist in inches');
    expect(estimate.steps[0]!.result).toBeCloseTo(33.46, 1);
    expect(estimate.steps[1]!.label).toBe('Weight in pounds');
    expect(estimate.steps[1]!.result).toBeCloseTo(165.3, 0);
    expectWellFormed(estimate);
  });

  it('uses the female constant for women', () => {
    const estimate = ymcaBodyFat(female)!;
    expect(estimate.variant).toBe('female');
    expect(estimate.value).toBeGreaterThan(ymcaBodyFat({ ...female, sex: 'male' })!.value);
  });

  it('is a rough guide on its own: low confidence, wide range', () => {
    const estimate = ymcaBodyFat(male)!;
    expect(estimate.confidence).toBe('low');
    expect(estimate.valueHigh - estimate.valueLow).toBeCloseTo(12, 1);
  });

  it('needs a waist and a weight', () => {
    expect(ymcaBodyFat({ sex: 'male', weightKg: 75, circumferencesCm: {} })).toBeUndefined();
    expect(ymcaBodyFat({ sex: 'male', circumferencesCm: { waist: 85 } })).toBeUndefined();
  });
});

describe('estimateBodyFat', () => {
  it('leads with the Navy formula and raises confidence when the YMCA formula agrees', () => {
    const assessment = estimateBodyFat(male);
    expect(assessment.estimates.map((e) => e.formula)).toEqual(['us_navy', 'ymca']);
    expect(assessment.primary?.formula).toBe('us_navy');
    expect(assessment.primary?.confidence).toBe('high');
    expect(assessment.primary?.confidenceReasons.join(' ')).toMatch(/YMCA formula agrees/);
    expect(assessment.estimates[1]!.confidence).toBe('moderate');
    expect(assessment.unavailable).toEqual([]);
    expect(assessment.note).toBe(BODY_FAT_ESTIMATE_NOTE);
  });

  it('narrows the range as confidence rises', () => {
    const alone = usNavyBodyFat(male)!;
    const corroborated = estimateBodyFat(male).primary!;
    expect(corroborated.valueHigh - corroborated.valueLow).toBeLessThan(
      alone.valueHigh - alone.valueLow,
    );
  });

  it('lowers confidence when the formulas disagree badly', () => {
    // Heavier body, same tape: the YMCA formula reads much leaner.
    const assessment = estimateBodyFat({ ...male, weightKg: 100 });
    const navy = assessment.estimates.find((e) => e.formula === 'us_navy')!;
    expect(navy.confidence).toBe('low');
    expect(navy.confidenceReasons.join(' ')).toMatch(/disagree by .* re-check the tape/);
  });

  it('only notes a moderate difference without changing confidence', () => {
    const assessment = estimateBodyFat({ ...male, weightKg: 90 });
    const navy = assessment.estimates.find((e) => e.formula === 'us_navy')!;
    expect(navy.confidence).toBe('moderate');
    expect(navy.confidenceReasons.join(' ')).toMatch(/differ by/);
  });

  it('never lets agreement rescue an implausible input', () => {
    const assessment = estimateBodyFat({ ...male, heightCm: 100 });
    const navy = assessment.estimates.find((e) => e.formula === 'us_navy')!;
    expect(navy.confidence).toBe('low');
  });

  it('says what each formula still needs when nothing can run', () => {
    const assessment = estimateBodyFat({ sex: 'male', circumferencesCm: {} });
    expect(assessment.estimates).toEqual([]);
    expect(assessment.primary).toBeUndefined();
    expect(assessment.unavailable).toEqual([
      { formula: 'us_navy', missing: ['Height', 'Neck', 'Waist'] },
      { formula: 'ymca', missing: ['Waist', 'Weight'] },
    ]);
  });

  it('asks a woman for her hips before running the Navy formula', () => {
    const assessment = estimateBodyFat({
      sex: 'female',
      heightCm: 165,
      weightKg: 58,
      circumferencesCm: { neck: 33, waist: 72 },
    });
    expect(assessment.estimates.map((e) => e.formula)).toEqual(['ymca']);
    expect(assessment.unavailable).toEqual([{ formula: 'us_navy', missing: ['Hips'] }]);
  });

  it('is deterministic', () => {
    expect(estimateBodyFat(male)).toEqual(estimateBodyFat(male));
    expect(estimateBodyFat(female)).toEqual(estimateBodyFat(female));
  });
});

describe('labelAiBodyFat', () => {
  it('starts low, with a wide range, when the service says little about itself', () => {
    const estimate = labelAiBodyFat({ value: 18, photosAnalysed: 4 });
    expect(estimate.method).toBe('ai');
    expect(estimate.confidence).toBe('low');
    expect(estimate.valueLow).toBe(12);
    expect(estimate.valueHigh).toBe(24);
    expect(estimate.confidenceReasons.join(' ')).toMatch(/did not report how confident/);
    expectWellFormed(estimate);
  });

  it('reaches moderate with all four sides and a confident service, but never high', () => {
    const estimate = labelAiBodyFat({
      value: 18,
      valueLow: 16,
      valueHigh: 21,
      modelConfidence: 1,
      photosAnalysed: 4,
    });
    expect(estimate.confidence).toBe('moderate');
    // The service's range is honoured but never allowed to be tighter than the floor.
    expect(estimate.valueLow).toBe(14);
    expect(estimate.valueHigh).toBe(22);
  });

  it('stays low when sides are missing, however confident the service is', () => {
    const estimate = labelAiBodyFat({ value: 18, modelConfidence: 0.95, photosAnalysed: 3 });
    expect(estimate.confidence).toBe('low');
    expect(estimate.confidenceReasons.join(' ')).toMatch(/3 of 4 sides/);
  });

  it('stays low when the service reports a very wide range', () => {
    const estimate = labelAiBodyFat({
      value: 18,
      valueLow: 8,
      valueHigh: 30,
      modelConfidence: 0.9,
      photosAnalysed: 4,
    });
    expect(estimate.confidence).toBe('low');
    expect(estimate.valueLow).toBe(8);
    expect(estimate.valueHigh).toBe(30);
  });

  it('clamps an absurd reading and flags it', () => {
    const estimate = labelAiBodyFat({ value: 75, modelConfidence: 0.9, photosAnalysed: 4 });
    expect(estimate.value).toBe(70);
    expect(estimate.valueHigh).toBe(70);
    expect(estimate.confidence).toBe('low');
    expect(estimate.confidenceReasons.join(' ')).toMatch(/plausible range/);
  });
});

describe('aiServiceGuidance', () => {
  it('points the athlete at the tape formula whenever the service cannot be used', () => {
    expect(aiServiceGuidance('active').useFormulaInstead).toBe(false);
    expect(aiServiceGuidance('unavailable').useFormulaInstead).toBe(true);
    expect(aiServiceGuidance('failed').useFormulaInstead).toBe(true);
    expect(aiServiceGuidance('failed').message).toMatch(/tape formula/);
  });
});

describe('preferredBodyFatEstimate', () => {
  it('prefers higher confidence, then the better method', () => {
    const navy = usNavyBodyFat(male)!;
    const ymca = ymcaBodyFat(male)!;
    const ai = labelAiBodyFat({ value: 17, modelConfidence: 0.9, photosAnalysed: 4 });

    expect(preferredBodyFatEstimate([ymca, navy])).toBe(navy);
    expect(preferredBodyFatEstimate([ai, navy])).toBe(navy);
    // Same confidence: the tape formula wins over the photo.
    expect(preferredBodyFatEstimate([ai, { ...navy, confidence: 'moderate' }])?.method).toBe(
      'formula',
    );
    // A photo estimate beats a formula estimate only when it is more confident.
    expect(preferredBodyFatEstimate([{ ...navy, confidence: 'low' }, ai])).toBe(ai);
    expect(preferredBodyFatEstimate([])).toBeUndefined();
  });
});
