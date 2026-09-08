import { describe, expect, it } from 'vitest';
import {
  comparableEfficiencyPoints,
  computeDecoupling,
  decouplingFromSplits,
  efficiencyFactor,
  efficiencyTrend,
  toEfficiencyPoint,
  type EfficiencyPoint,
} from './efficiency.js';
import { makeCanonicalWorkout, makeSteadySamples } from '../__fixtures__/index.js';

describe('efficiencyFactor', () => {
  it('rises when pace improves at the same heart rate', () => {
    // 7 km in 45 min vs 7 km in 42 min, both at 145 bpm.
    const slower = efficiencyFactor(7000, 2700, 145)!;
    const faster = efficiencyFactor(7000, 2520, 145)!;
    expect(faster).toBeGreaterThan(slower);
  });

  it('falls when heart rate rises at the same pace', () => {
    const lowHr = efficiencyFactor(7000, 2700, 140)!;
    const highHr = efficiencyFactor(7000, 2700, 155)!;
    expect(highHr).toBeLessThan(lowHr);
  });

  it('returns undefined for degenerate inputs', () => {
    expect(efficiencyFactor(0, 2700, 145)).toBeUndefined();
    expect(efficiencyFactor(7000, 0, 145)).toBeUndefined();
    expect(efficiencyFactor(7000, 2700, 0)).toBeUndefined();
  });
});

describe('comparableEfficiencyPoints', () => {
  const base = (overrides: Partial<EfficiencyPoint>): EfficiencyPoint => ({
    workoutId: 'w',
    date: '2026-08-01',
    efficiencyFactor: 1.1,
    paceSecondsPerKm: 380,
    avgHeartRateBpm: 145,
    distanceMeters: 8000,
    context: { indoor: false, workoutType: 'easy' },
    ...overrides,
  });

  it('keeps steady aerobic runs', () => {
    expect(comparableEfficiencyPoints([base({})])).toHaveLength(1);
  });

  it('excludes interval sessions, where average heart rate is meaningless', () => {
    const intervals = base({ context: { indoor: false, workoutType: 'intervals' } });
    expect(comparableEfficiencyPoints([intervals])).toHaveLength(0);
  });

  it('excludes very short runs', () => {
    expect(comparableEfficiencyPoints([base({ distanceMeters: 1500 })])).toHaveLength(0);
  });

  it('excludes hilly runs, where elevation confounds the comparison', () => {
    const hilly = base({
      context: { indoor: false, workoutType: 'easy', elevationGainPerKm: 45 },
    });
    expect(comparableEfficiencyPoints([hilly])).toHaveLength(0);
  });

  it('excludes runs in the heat, which inflates heart rate independently of fitness', () => {
    const hot = base({
      context: { indoor: false, workoutType: 'easy', temperatureCelsius: 34 },
    });
    expect(comparableEfficiencyPoints([hot])).toHaveLength(0);
  });
});

describe('efficiencyTrend', () => {
  const makePoints = (efs: number[]): EfficiencyPoint[] =>
    efs.map((ef, i) => ({
      workoutId: `w-${i}`,
      // One run per week.
      date: `2026-0${Math.floor(i / 4) + 6}-${String((i % 4) * 7 + 1).padStart(2, '0')}`,
      efficiencyFactor: ef,
      paceSecondsPerKm: 380,
      avgHeartRateBpm: 145,
      distanceMeters: 8000,
      context: { indoor: false, workoutType: 'easy' },
    }));

  it('refuses to call a trend from too few points', () => {
    expect(efficiencyTrend(makePoints([1.0, 1.1]))).toBeUndefined();
  });

  it('detects a genuine improvement', () => {
    const trend = efficiencyTrend(makePoints([1.0, 1.03, 1.06, 1.09, 1.12, 1.15]))!;
    expect(trend.direction).toBe('improving');
    expect(trend.changePercent).toBeGreaterThan(0);
  });

  it('detects a decline', () => {
    const trend = efficiencyTrend(makePoints([1.15, 1.12, 1.09, 1.06, 1.03, 1.0]))!;
    expect(trend.direction).toBe('declining');
    expect(trend.changePercent).toBeLessThan(0);
  });

  it('calls small fluctuations stable rather than a trend', () => {
    const trend = efficiencyTrend(makePoints([1.1, 1.11, 1.09, 1.1, 1.105, 1.095]))!;
    expect(trend.direction).toBe('stable');
  });

  it('gives noisy data lower confidence than clean data', () => {
    const clean = efficiencyTrend(makePoints([1.0, 1.03, 1.06, 1.09, 1.12, 1.15, 1.18, 1.21]))!;
    const noisy = efficiencyTrend(makePoints([1.0, 1.3, 0.9, 1.4, 0.95, 1.35]))!;
    const rank = { low: 0, moderate: 1, high: 2 };
    expect(rank[noisy.confidence]).toBeLessThan(rank[clean.confidence]);
  });

  it('always produces a human-readable interpretation', () => {
    const trend = efficiencyTrend(makePoints([1.0, 1.03, 1.06, 1.09, 1.12, 1.15]))!;
    expect(trend.interpretation.length).toBeGreaterThan(20);
  });
});

describe('computeDecoupling', () => {
  it('reports low drift for a well-coupled steady run', () => {
    const samples = makeSteadySamples({
      durationSeconds: 3600,
      speedMps: 2.8,
      startHeartRate: 145,
      driftPercent: 2,
    });
    const result = computeDecoupling(samples)!;
    expect(result.isValid).toBe(true);
    expect(result.driftPercent).toBeGreaterThan(0);
    expect(result.driftPercent).toBeLessThan(5);
    expect(result.interpretation).toMatch(/coupled range/i);
  });

  it('reports high drift when heart rate climbs at constant pace', () => {
    const samples = makeSteadySamples({
      durationSeconds: 3600,
      speedMps: 2.8,
      startHeartRate: 140,
      driftPercent: 14,
    });
    const result = computeDecoupling(samples)!;
    expect(result.isValid).toBe(true);
    expect(result.driftPercent).toBeGreaterThan(5);
  });

  it('never claims a cause from a single session', () => {
    const samples = makeSteadySamples({
      durationSeconds: 3600,
      speedMps: 2.8,
      startHeartRate: 140,
      driftPercent: 14,
    });
    const result = computeDecoupling(samples)!;
    // Interpretation should hedge, listing possibilities rather than a cause.
    expect(result.interpretation).toMatch(/heat|hydration|fatigue|often/i);
  });

  it('rejects an interval session as not steady enough', () => {
    const samples = makeSteadySamples({
      durationSeconds: 3600,
      speedMps: 2.8,
      startHeartRate: 145,
      driftPercent: 3,
      jitter: 0.45,
    });
    const result = computeDecoupling(samples)!;
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/steady/i);
  });

  it('rejects a run too short to show drift', () => {
    const samples = makeSteadySamples({
      durationSeconds: 600,
      speedMps: 2.8,
      startHeartRate: 145,
      driftPercent: 3,
    });
    const result = computeDecoupling(samples)!;
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/20\+ minutes/);
  });

  it('returns undefined when there are too few usable samples', () => {
    expect(computeDecoupling([{ offsetSeconds: 0, heartRateBpm: 140, speedMps: 2.8 }])).toBeUndefined();
  });

  it('handles negative drift (a positive split run) without error', () => {
    const samples = makeSteadySamples({
      durationSeconds: 3600,
      speedMps: 2.8,
      startHeartRate: 150,
      driftPercent: -6,
    });
    const result = computeDecoupling(samples)!;
    expect(result.driftPercent).toBeLessThan(0);
    expect(result.interpretation).toMatch(/fell/i);
  });
});

describe('decouplingFromSplits', () => {
  it('derives drift from lap data when no sample stream exists', () => {
    const splits = [
      { distanceMeters: 1000, durationSeconds: 360, avgHeartRateBpm: 140 },
      { distanceMeters: 1000, durationSeconds: 360, avgHeartRateBpm: 142 },
      { distanceMeters: 1000, durationSeconds: 360, avgHeartRateBpm: 150 },
      { distanceMeters: 1000, durationSeconds: 360, avgHeartRateBpm: 152 },
    ];
    const result = decouplingFromSplits(splits)!;
    expect(result.driftPercent).toBeGreaterThan(0);
  });

  it('returns undefined with too few splits', () => {
    expect(
      decouplingFromSplits([{ distanceMeters: 1000, durationSeconds: 360, avgHeartRateBpm: 140 }]),
    ).toBeUndefined();
  });

  it('returns undefined when splits carry no heart rate', () => {
    const splits = Array.from({ length: 6 }, () => ({
      distanceMeters: 1000,
      durationSeconds: 360,
    }));
    expect(decouplingFromSplits(splits)).toBeUndefined();
  });
});

describe('toEfficiencyPoint', () => {
  it('extracts a point from a complete workout', () => {
    const point = toEfficiencyPoint(makeCanonicalWorkout())!;
    expect(point.efficiencyFactor).toBeGreaterThan(0);
    expect(point.context.workoutType).toBe('easy');
  });

  it('returns undefined when heart rate is missing', () => {
    expect(toEfficiencyPoint(makeCanonicalWorkout({ avgHeartRateBpm: undefined }))).toBeUndefined();
  });
});
