/**
 * The shape refuses to hand out a single number, and the formatting refuses to
 * imply more precision than a band has. Both are worth pinning down.
 */

import { describe, expect, it } from 'vitest';

import {
  CONFIDENCE_LABELS,
  METHOD_LABELS,
  NON_MEDICAL_NOTE,
  STUB_ESTIMATES,
  estimateFor,
  formatRange,
  rangeWidth,
} from './body-fat';

describe('formatRange', () => {
  it('shows a band, never a single figure', () => {
    expect(formatRange({ valueLow: 17.4, valueHigh: 20.2 })).toBe('17.4–20.2%');
  });

  it('keeps both bounds even when they round the same', () => {
    // A zero-width band is still shown as a band; collapsing it to "18.0%"
    // would read as a measurement.
    expect(formatRange({ valueLow: 18, valueHigh: 18 })).toBe('18.0–18.0%');
  });

  it('shows a placeholder rather than a nonsense band', () => {
    expect(formatRange({ valueLow: Number.NaN, valueHigh: 20 })).toBe('—');
    expect(formatRange({ valueLow: 17, valueHigh: Number.POSITIVE_INFINITY })).toBe('—');
  });
});

describe('rangeWidth', () => {
  it('measures how wide the band is', () => {
    expect(rangeWidth({ valueLow: 17.4, valueHigh: 20.2 })).toBeCloseTo(2.8, 6);
  });

  it('is never negative, whichever way round the bounds came', () => {
    expect(rangeWidth({ valueLow: 20.2, valueHigh: 17.4 })).toBeCloseTo(2.8, 6);
  });
});

describe('estimates', () => {
  it('finds an estimate by method', () => {
    expect(estimateFor(STUB_ESTIMATES, 'formula')?.method).toBe('formula');
    expect(estimateFor(STUB_ESTIMATES, 'ai')?.method).toBe('ai');
    expect(estimateFor([], 'formula')).toBeUndefined();
  });

  it('carries no single value field for a caller to latch onto', () => {
    for (const estimate of STUB_ESTIMATES) {
      expect(estimate).not.toHaveProperty('value');
      expect(estimate.valueHigh).toBeGreaterThanOrEqual(estimate.valueLow);
    }
  });

  it('does not claim a photograph is tighter than a tape measure', () => {
    const formula = estimateFor(STUB_ESTIMATES, 'formula')!;
    const ai = estimateFor(STUB_ESTIMATES, 'ai')!;

    expect(rangeWidth(ai)).toBeGreaterThan(rangeWidth(formula));
  });

  it('states what every estimate rests on', () => {
    for (const estimate of STUB_ESTIMATES) {
      expect(estimate.basis.length).toBeGreaterThan(0);
      expect(CONFIDENCE_LABELS[estimate.confidence]).toBeDefined();
      expect(METHOD_LABELS[estimate.method]).toBeDefined();
    }
  });

  it('never labels an estimate as certain', () => {
    // Nothing available here earns "high"; if a method ever does, that is a
    // deliberate decision and this test is where it gets made.
    expect(STUB_ESTIMATES.every((estimate) => estimate.confidence !== 'high')).toBe(true);
  });
});

describe('the disclaimer', () => {
  it('says plainly that this is not a medical measurement', () => {
    expect(NON_MEDICAL_NOTE).toContain('not a medical measurement');
    expect(NON_MEDICAL_NOTE).toContain('trend');
  });
});
