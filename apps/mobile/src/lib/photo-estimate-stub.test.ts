/**
 * The simulation encodes two product rules — one reading per session, and a
 * wider band than the tape — so those are what these check, rather than the
 * arithmetic of a hash.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { NAVY_STANDARD_ERROR } from '@running/core';

import {
  PHOTO_MARGIN,
  cachedPhotoEstimate,
  clearPhotoEstimateCache,
  clearPhotoEstimateFor,
  requestPhotoEstimate,
  simulatedPhotoBand,
  simulatedPhotoEstimate,
} from './photo-estimate-stub';
import { rangeWidth } from './body-fat';

const SESSION = 'session-2026-09-06';
const OTHER = 'session-2026-08-09';

beforeEach(() => clearPhotoEstimateCache());

describe('simulatedPhotoBand', () => {
  it('gives the same session the same band every time', () => {
    // The model does not change its mind about photographs it has already
    // seen, and neither does the simulation.
    expect(simulatedPhotoBand(SESSION)).toEqual(simulatedPhotoBand(SESSION));
  });

  it('gives different sessions different bands', () => {
    expect(simulatedPhotoBand(SESSION)).not.toEqual(simulatedPhotoBand(OTHER));
  });

  it('lands somewhere plausible', () => {
    for (const id of [SESSION, OTHER, 'a', 'b', 'session-2026-06-14', '']) {
      const band = simulatedPhotoBand(id);
      expect(band.valueLow).toBeGreaterThan(0);
      expect(band.valueHigh).toBeLessThan(45);
      expect(band.valueHigh).toBeGreaterThan(band.valueLow);
    }
  });

  it('spans twice the margin either side of its centre', () => {
    expect(rangeWidth(simulatedPhotoBand(SESSION))).toBeCloseTo(PHOTO_MARGIN * 2, 6);
  });
});

describe('simulatedPhotoEstimate', () => {
  it('never claims more than low confidence', () => {
    // It is the weakest signal on offer and the label should say so.
    expect(simulatedPhotoEstimate(SESSION).confidence).toBe('low');
  });

  it('states what it read', () => {
    const estimate = simulatedPhotoEstimate(SESSION);

    expect(estimate.method).toBe('ai');
    expect(estimate.sessionId).toBe(SESSION);
    expect(estimate.basis).toContain('photos');
  });
});

describe('requestPhotoEstimate', () => {
  it('reads the photos once and reuses the answer', async () => {
    const first = await requestPhotoEstimate(SESSION, { latencyMs: 0 });
    const second = await requestPhotoEstimate(SESSION, { latencyMs: 0 });

    expect(first.status).toBe('done');
    expect(second.status).toBe('done');
    if (first.status !== 'done' || second.status !== 'done') return;

    // Re-analysing the same photographs is out of scope, and a second run
    // producing a different number would be noise dressed as new information.
    expect(second.fromCache).toBe(true);
    expect(first.fromCache).toBe(false);
    expect(second.estimate.valueLow).toBe(first.estimate.valueLow);
    expect(second.estimate.valueHigh).toBe(first.estimate.valueHigh);
  });

  it('returns a cached reading without waiting', async () => {
    await requestPhotoEstimate(SESSION, { latencyMs: 0 });

    // A long latency would make this hang if the cache were not consulted
    // before the delay.
    const started = Date.now();
    const result = await requestPhotoEstimate(SESSION, { latencyMs: 10_000 });

    expect(result.status).toBe('done');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('caches per session, not globally', async () => {
    const mine = await requestPhotoEstimate(SESSION, { latencyMs: 0 });
    const other = await requestPhotoEstimate(OTHER, { latencyMs: 0 });

    if (mine.status !== 'done' || other.status !== 'done') throw new Error('expected results');
    expect(other.fromCache).toBe(false);
    expect(other.estimate.sessionId).toBe(OTHER);
  });

  it('reports a failure with its reason', async () => {
    const result = await requestPhotoEstimate(SESSION, {
      latencyMs: 0,
      failWith: 'The service did not respond.',
    });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.reason).toBe('The service did not respond.');
  });

  it('does not cache a failure', async () => {
    await requestPhotoEstimate(SESSION, { latencyMs: 0, failWith: 'boom' });

    // The photos were never read, so asking again is a legitimate retry
    // rather than a repeat analysis.
    expect(cachedPhotoEstimate(SESSION)).toBeUndefined();

    const retry = await requestPhotoEstimate(SESSION, { latencyMs: 0 });
    expect(retry.status).toBe('done');
  });

  it('clears on demand', async () => {
    await requestPhotoEstimate(SESSION, { latencyMs: 0 });
    expect(cachedPhotoEstimate(SESSION)).toBeDefined();

    clearPhotoEstimateCache();
    expect(cachedPhotoEstimate(SESSION)).toBeUndefined();
  });
});

describe('the two methods together', () => {
  it('does not present a photograph as sharper than a tape measure', () => {
    // The formula's band is its published standard error either side. The
    // photo band has to be wider than that, or the weaker signal would read
    // as the more precise one.
    expect(PHOTO_MARGIN).toBeGreaterThan(NAVY_STANDARD_ERROR);
  });
});

describe('clearPhotoEstimateFor', () => {
  it('drops one session reading and leaves the others', async () => {
    await requestPhotoEstimate(SESSION, { latencyMs: 0 });
    await requestPhotoEstimate(OTHER, { latencyMs: 0 });

    expect(clearPhotoEstimateFor(SESSION)).toBe(true);

    // A number derived from someone's photographs is as much about their body
    // as the photographs were; it must not outlive them.
    expect(cachedPhotoEstimate(SESSION)).toBeUndefined();
    expect(cachedPhotoEstimate(OTHER)).toBeDefined();
  });

  it('reports whether there was anything to drop', () => {
    expect(clearPhotoEstimateFor('never-read')).toBe(false);
  });
});
