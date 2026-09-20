/**
 * The shape refuses to hand out a single number, and the formatting refuses to
 * imply more precision than a band has. Both are worth pinning down.
 */

import { describe, expect, it } from 'vitest';

import {
  BODY_FAT_SCALE,
  CONFIDENCE_LABELS,
  METHOD_LABELS,
  MIN_BAND_FRACTION,
  NON_MEDICAL_NOTE,
  STUB_ESTIMATES,
  aiAvailabilityMessage,
  bandGeometry,
  estimateFor,
  formatRange,
  rangeWidth,
  scalePosition,
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

describe('scalePosition', () => {
  it('places the ends of the scale at the ends of the track', () => {
    expect(scalePosition(BODY_FAT_SCALE.min)).toBe(0);
    expect(scalePosition(BODY_FAT_SCALE.max)).toBe(1);
  });

  it('places the midpoint halfway', () => {
    expect(scalePosition((BODY_FAT_SCALE.min + BODY_FAT_SCALE.max) / 2)).toBeCloseTo(0.5, 10);
  });

  it('pins a reading outside the scale to the edge', () => {
    // A band running off the end would look like a rendering bug rather than
    // an unusual measurement.
    expect(scalePosition(BODY_FAT_SCALE.min - 10)).toBe(0);
    expect(scalePosition(BODY_FAT_SCALE.max + 10)).toBe(1);
  });

  it('does not propagate a non-finite value into a layout', () => {
    expect(scalePosition(Number.NaN)).toBe(0);
    expect(scalePosition(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('bandGeometry', () => {
  it('starts at the lower bound and spans to the upper', () => {
    const { start, width } = bandGeometry(BODY_FAT_SCALE.min, BODY_FAT_SCALE.max);

    expect(start).toBe(0);
    expect(width).toBeCloseTo(1, 10);
  });

  it('tolerates bounds given the wrong way round', () => {
    // An estimate is a range whichever order its ends arrive in.
    expect(bandGeometry(25, 15)).toEqual(bandGeometry(15, 25));
  });

  it('keeps a zero-width band visible', () => {
    const { width } = bandGeometry(20, 20);

    // Collapsing to nothing would read as "no estimate" rather than a tight one.
    expect(width).toBe(MIN_BAND_FRACTION);
    expect(width).toBeGreaterThan(0);
  });

  it('never runs the band past the end of the track', () => {
    for (const [low, high] of [
      [17.4, 20.2],
      [4, 60],
      [44.9, 44.95],
      [0, 5],
    ] as const) {
      const { start, width } = bandGeometry(low, high);
      expect(start).toBeGreaterThanOrEqual(0);
      // The minimum width can push a band pinned at the far edge marginally
      // over; anything beyond that is a real overflow.
      expect(start + width).toBeLessThanOrEqual(1 + MIN_BAND_FRACTION);
    }
  });

  it('draws the stub estimates inside the scale', () => {
    for (const estimate of STUB_ESTIMATES) {
      const { start, width } = bandGeometry(estimate.valueLow, estimate.valueHigh);
      expect(start).toBeGreaterThan(0);
      expect(start + width).toBeLessThan(1);
    }
  });
});

describe('aiAvailabilityMessage', () => {
  it('says the service is running when it is', () => {
    const message = aiAvailabilityMessage('active', true);

    expect(message.availability).toBe('ready');
    expect(message.suggestFormula).toBe(false);
    expect(message.action).toBeUndefined();
  });

  it('distinguishes a missing photo set from a broken service', () => {
    // Collapsing both into "unavailable" would send someone to wait for a
    // service that was never the problem.
    const noPhotos = aiAvailabilityMessage('active', false);
    const down = aiAvailabilityMessage('unavailable', true);

    expect(noPhotos.availability).toBe('no_photos');
    expect(down.availability).toBe('unavailable');
    expect(noPhotos.title).not.toBe(down.title);
  });

  it('checks for photos before it checks the service', () => {
    // With no photos there is nothing to send, so the service being down is
    // not the thing to tell the athlete about.
    expect(aiAvailabilityMessage('failed', false).availability).toBe('no_photos');
    expect(aiAvailabilityMessage(undefined, false).availability).toBe('no_photos');
  });

  it('separates a failed read from an unreachable service', () => {
    expect(aiAvailabilityMessage('failed', true).availability).toBe('failed');
    expect(aiAvailabilityMessage('unavailable', true).availability).toBe('unavailable');
  });

  it('treats an unknown status as unavailable rather than assuming it works', () => {
    expect(aiAvailabilityMessage(undefined, true).availability).toBe('unavailable');
  });

  it('always offers a way forward when the photo path cannot run', () => {
    for (const status of ['unavailable', 'failed'] as const) {
      const message = aiAvailabilityMessage(status, true);

      // An athlete told only that something is broken has a dead end.
      expect(message.suggestFormula).toBe(true);
      expect(message.action).toBe('switch_to_formula');
      expect(message.body).toContain('measurements method');
    }
  });

  it('does not redirect away from photos when photos are what is missing', () => {
    const message = aiAvailabilityMessage('active', false);

    // Taking four photos is the thing they came to do.
    expect(message.action).toBe('take_photos');
    expect(message.suggestFormula).toBe(false);
  });

  it('reassures that photos survive a failed read', () => {
    expect(aiAvailabilityMessage('failed', true).body).toContain('photos are untouched');
  });
});
