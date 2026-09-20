/**
 * The requirement checklist is what the screen renders and what decides
 * whether the formula may run, so its edges are worth pinning down.
 */

import { describe, expect, it } from 'vitest';

import {
  HEIGHT_BOUNDS_CM,
  VARIANT_DESCRIPTIONS,
  VARIANT_LABELS,
  VARIANT_NOTE,
  VARIANT_REQUIRED_POINTS,
  WEIGHT_BOUNDS_KG,
  canRunFormula,
  formulaRequirements,
  isPlausibleHeightCm,
  isPlausibleWeightKg,
  outstanding,
} from './body-fat-inputs';

const ALL_POINTS = ['waist', 'neck', 'hips'];

describe('plausibility guards', () => {
  it('accepts an adult height and weight', () => {
    expect(isPlausibleHeightCm(178)).toBe(true);
    expect(isPlausibleWeightKg(72.4)).toBe(true);
  });

  it('catches a height typed in metres', () => {
    // 1.78 is the classic one.
    expect(isPlausibleHeightCm(1.78)).toBe(false);
    expect(isPlausibleHeightCm(HEIGHT_BOUNDS_CM.min)).toBe(true);
    expect(isPlausibleHeightCm(HEIGHT_BOUNDS_CM.max)).toBe(true);
  });

  it('catches a weight typed in the wrong unit', () => {
    // 160 lb entered as kilograms.
    expect(isPlausibleWeightKg(400)).toBe(false);
    expect(isPlausibleWeightKg(WEIGHT_BOUNDS_KG.min)).toBe(true);
    expect(isPlausibleWeightKg(WEIGHT_BOUNDS_KG.max)).toBe(true);
  });

  it('rejects non-finite values rather than passing them on', () => {
    expect(isPlausibleHeightCm(Number.NaN)).toBe(false);
    expect(isPlausibleWeightKg(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('formulaRequirements', () => {
  it('lists what is satisfied as well as what is missing', () => {
    const requirements = formulaRequirements({ variant: 'male', heightCm: 178 }, ALL_POINTS);

    // A list that only shrinks tells the athlete nothing about what the
    // calculation rests on.
    expect(requirements.every((r) => r.satisfied)).toBe(true);
    expect(requirements.length).toBeGreaterThan(2);
  });

  it('does not ask for circumferences before a variant is chosen', () => {
    const requirements = formulaRequirements({ heightCm: 178 }, []);

    // Which ones are needed is genuinely unknown until then, and guessing
    // would show a requirement that might vanish.
    expect(requirements.some((r) => r.key.startsWith('point:'))).toBe(false);
    expect(requirements.find((r) => r.key === 'variant')?.satisfied).toBe(false);
  });

  it('asks for hips only on the variant that reads them', () => {
    const male = formulaRequirements({ variant: 'male', heightCm: 178 }, ALL_POINTS);
    const female = formulaRequirements({ variant: 'female', heightCm: 168 }, ALL_POINTS);

    expect(male.some((r) => r.key === 'point:hips')).toBe(false);
    expect(female.some((r) => r.key === 'point:hips')).toBe(true);
    expect(VARIANT_REQUIRED_POINTS.female).toContain('hips');
    expect(VARIANT_REQUIRED_POINTS.male).not.toContain('hips');
  });

  it('marks a circumference the session has not recorded', () => {
    const requirements = formulaRequirements({ variant: 'female', heightCm: 168 }, [
      'waist',
      'neck',
    ]);

    const hips = requirements.find((r) => r.key === 'point:hips');
    expect(hips?.satisfied).toBe(false);
    expect(hips?.detail).toContain('circumference screen');
  });

  it('rejects an implausible height as unsatisfied, not just absent', () => {
    const requirements = formulaRequirements({ variant: 'male', heightCm: 1.78 }, ALL_POINTS);

    expect(requirements.find((r) => r.key === 'height')?.satisfied).toBe(false);
  });

  it('explains every requirement whether or not it is met', () => {
    for (const inputs of [{}, { variant: 'male' as const, heightCm: 178 }]) {
      for (const requirement of formulaRequirements(inputs, ALL_POINTS)) {
        expect(requirement.detail.length).toBeGreaterThan(0);
        expect(requirement.label.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('canRunFormula', () => {
  it('needs everything, not most things', () => {
    expect(canRunFormula(formulaRequirements({ variant: 'male', heightCm: 178 }, ALL_POINTS))).toBe(
      true,
    );
    expect(canRunFormula(formulaRequirements({ variant: 'male' }, ALL_POINTS))).toBe(false);
    expect(canRunFormula(formulaRequirements({ variant: 'male', heightCm: 178 }, ['waist']))).toBe(
      false,
    );
  });

  it('will not call an empty checklist runnable', () => {
    expect(canRunFormula([])).toBe(false);
  });

  it('names what is outstanding', () => {
    const missing = outstanding(formulaRequirements({ variant: 'female' }, ['waist']));

    expect(missing.map((r) => r.key).sort()).toEqual(['height', 'point:hips', 'point:neck']);
  });
});

describe('how the variant choice is framed', () => {
  it('describes what each equation reads, not what the athlete is', () => {
    // The athlete picks an equation on the measurements available; the app
    // does not ask them to declare something about themselves.
    for (const description of Object.values(VARIANT_DESCRIPTIONS)) {
      expect(description).toMatch(/^Reads /);
    }
    for (const label of Object.values(VARIANT_LABELS)) {
      expect(label).toContain('coefficients');
    }
    expect(VARIANT_NOTE).toContain('coefficients');
    expect(VARIANT_NOTE).toContain('reference populations');
  });
});
