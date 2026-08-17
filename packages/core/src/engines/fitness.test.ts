import { describe, expect, it } from 'vitest';
import {
  estimateFitness,
  easyPaceRangeFromVdot,
  predictFromVdot,
  predictRace,
  riegelPredict,
  thresholdPaceFromVdot,
  vdotFromPerformance,
} from './fitness.js';

const TODAY = '2026-08-17';

describe('riegelPredict', () => {
  it('predicts a slower average pace at a longer distance', () => {
    // 25:40 5K -> 10K should be slower than a straight doubling (51:20).
    const tenK = riegelPredict(5000, 1540, 10000)!;
    expect(tenK).toBeGreaterThan(1540 * 2);
    expect(tenK).toBeLessThan(1540 * 2.2);
  });

  it('is self-consistent at the same distance', () => {
    expect(riegelPredict(5000, 1500, 5000)).toBeCloseTo(1500, 5);
  });

  it('returns undefined for nonsensical inputs', () => {
    expect(riegelPredict(0, 1500, 5000)).toBeUndefined();
    expect(riegelPredict(5000, 0, 5000)).toBeUndefined();
    expect(riegelPredict(5000, 1500, -1)).toBeUndefined();
  });
});

describe('VDOT model', () => {
  it('produces a plausible VDOT for a 25:40 5K', () => {
    const vdot = vdotFromPerformance(5000, 1540)!;
    // A 25:40 5K corresponds to roughly VDOT 38-42.
    expect(vdot).toBeGreaterThan(36);
    expect(vdot).toBeLessThan(44);
  });

  it('gives a higher VDOT for a faster time at the same distance', () => {
    const slower = vdotFromPerformance(5000, 1540)!;
    const faster = vdotFromPerformance(5000, 1320)!;
    expect(faster).toBeGreaterThan(slower);
  });

  it('round-trips: predicting from a VDOT reproduces the source time', () => {
    const vdot = vdotFromPerformance(5000, 1540)!;
    const predicted = predictFromVdot(vdot, 5000)!;
    expect(predicted).toBeCloseTo(1540, -1); // within ~10s
  });

  it('rejects efforts outside the model’s valid range', () => {
    // A 20-second "run" is not a sustained aerobic effort.
    expect(vdotFromPerformance(100, 20)).toBeUndefined();
  });

  it('derives a threshold pace faster than easy pace', () => {
    const vdot = 42;
    const threshold = thresholdPaceFromVdot(vdot)!;
    const [easyFast, easySlow] = easyPaceRangeFromVdot(vdot)!;

    // Lower seconds/km == faster.
    expect(threshold).toBeLessThan(easyFast);
    expect(easyFast).toBeLessThan(easySlow);
  });
});

describe('estimateFitness', () => {
  it('reports low confidence and no estimate with no data', () => {
    const result = estimateFitness([], TODAY);
    expect(result.vdot).toBeUndefined();
    expect(result.confidence).toBe('low');
    expect(result.basis).toMatch(/No recent/i);
  });

  it('produces an estimate from a single recent race', () => {
    const result = estimateFitness(
      [{ distanceMeters: 5000, durationSeconds: 1540, date: '2026-08-01', source: 'race' }],
      TODAY,
    );
    expect(result.vdot).toBeDefined();
    expect(result.thresholdPaceSecondsPerKm).toBeDefined();
    expect(result.confidence).toBe('high');
    expect(result.asOfDate).toBe('2026-08-01');
  });

  it('weights a recent race above a stale one', () => {
    // 2025-06-01 is more than 365 days before 2026-08-17, so it is dropped.
    const stale = estimateFitness(
      [{ distanceMeters: 5000, durationSeconds: 1800, date: '2025-06-01', source: 'race' }],
      TODAY,
    );
    expect(stale.vdot).toBeUndefined();

    const mixed = estimateFitness(
      [
        { distanceMeters: 5000, durationSeconds: 1800, date: '2026-02-01', source: 'race' },
        { distanceMeters: 5000, durationSeconds: 1500, date: '2026-08-10', source: 'race' },
      ],
      TODAY,
    );
    const recentOnly = vdotFromPerformance(5000, 1500)!;
    const staleOnly = vdotFromPerformance(5000, 1800)!;
    // The blend should sit much closer to the recent performance.
    expect(mixed.vdot!).toBeGreaterThan((recentOnly + staleOnly) / 2);
  });

  it('downgrades confidence for self-reported data only', () => {
    const result = estimateFitness(
      [
        {
          distanceMeters: 5000,
          durationSeconds: 1540,
          date: '2026-08-01',
          source: 'self_reported',
        },
      ],
      TODAY,
    );
    expect(result.confidence).not.toBe('high');
  });
});

describe('predictRace', () => {
  const fitness = estimateFitness(
    [{ distanceMeters: 5000, durationSeconds: 1540, date: '2026-08-01', source: 'race' }],
    TODAY,
  );
  const best = {
    distanceMeters: 5000,
    durationSeconds: 1540,
    date: '2026-08-01',
    source: 'race' as const,
  };

  it('predicts a 10K slower than double the 5K', () => {
    const prediction = predictRace(10000, fitness, best, TODAY)!;
    expect(prediction.predictedDurationSeconds).toBeGreaterThan(1540 * 2);
    expect(prediction.method).toBe('blended');
  });

  it('reports pace consistent with the predicted time', () => {
    const prediction = predictRace(10000, fitness, best, TODAY)!;
    const impliedPace = (prediction.predictedDurationSeconds / 10000) * 1000;
    expect(prediction.predictedPaceSecondsPerKm).toBeCloseTo(impliedPace, 5);
  });

  it('downgrades confidence when extrapolating from 5K to marathon', () => {
    const tenK = predictRace(10000, fitness, best, TODAY)!;
    const marathon = predictRace(42195, fitness, best, TODAY)!;

    const rank = { low: 0, moderate: 1, high: 2 };
    expect(rank[marathon.confidence]).toBeLessThan(rank[tenK.confidence]);
  });

  it('returns undefined when there is nothing to predict from', () => {
    const empty = estimateFitness([], TODAY);
    expect(predictRace(10000, empty, undefined, TODAY)).toBeUndefined();
  });

  it('always states its basis', () => {
    const prediction = predictRace(10000, fitness, best, TODAY)!;
    expect(prediction.basis.length).toBeGreaterThan(0);
    expect(prediction.basis).toContain('2026-08-01');
  });
});
