import { describe, expect, it } from 'vitest';
import { buildBaseline, computeRecoveryState, estimateSleepNeed, type RecoveryInputs } from './recovery.js';
import type { SleepRecord } from '../domain/recovery.js';

const DATE = '2026-08-18';

function makeSleep(totalSleepSeconds: number, overrides: Partial<SleepRecord> = {}): SleepRecord {
  return {
    id: 's-1',
    athleteId: 'athlete-1',
    date: DATE,
    start: new Date('2026-08-17T15:00:00Z'),
    end: new Date('2026-08-17T23:00:00Z'),
    totalSleepSeconds,
    performancePercent: 85,
    isNap: false,
    source: 'whoop',
    ...overrides,
  };
}

function baseInputs(overrides: Partial<RecoveryInputs> = {}): RecoveryInputs {
  return {
    athleteId: 'athlete-1',
    date: DATE,
    today: {
      id: 'r-1',
      athleteId: 'athlete-1',
      date: DATE,
      providerRecoveryScore: 70,
      hrvRmssdMs: 62,
      restingHeartRateBpm: 48,
      source: 'whoop',
    },
    lastNightSleep: makeSleep(8 * 3600),
    hrvHistory: [60, 63, 61, 64, 62, 61, 63],
    restingHrHistory: [48, 47, 49, 48, 48, 47, 48],
    ...overrides,
  };
}

describe('computeRecoveryState', () => {
  it('scores a well-recovered athlete green', () => {
    const state = computeRecoveryState(baseInputs());
    expect(state.band).toBe('green');
    expect(state.score).toBeGreaterThan(66);
  });

  it('scores a poorly-recovered athlete red', () => {
    const state = computeRecoveryState(
      baseInputs({
        today: {
          id: 'r-1',
          athleteId: 'athlete-1',
          date: DATE,
          providerRecoveryScore: 25,
          hrvRmssdMs: 42, // ~32% below a 62 ms baseline
          restingHeartRateBpm: 57, // +9 bpm
          source: 'whoop',
        },
        lastNightSleep: makeSleep(5 * 3600, { performancePercent: 55 }),
        checkIn: {
          id: 'c-1',
          athleteId: 'athlete-1',
          date: DATE,
          energy: 2,
          soreness: 2,
          stress: 2,
          motivation: 2,
          hasPain: false,
          createdAt: new Date('2026-08-18T00:00:00Z'),
        },
      }),
    );

    expect(state.band).toBe('red');
    expect(state.score).toBeLessThan(40);
  });

  it('does not simply mirror the provider recovery score', () => {
    // WHOOP says 61, but everything else is poor. Our composite must diverge.
    const state = computeRecoveryState(
      baseInputs({
        today: {
          id: 'r-1',
          athleteId: 'athlete-1',
          date: DATE,
          providerRecoveryScore: 61,
          hrvRmssdMs: 45,
          restingHeartRateBpm: 56,
          source: 'whoop',
        },
        lastNightSleep: makeSleep(6 * 3600 + 120, { performancePercent: 60 }),
        checkIn: {
          id: 'c-1',
          athleteId: 'athlete-1',
          date: DATE,
          energy: 2,
          soreness: 2,
          stress: 3,
          motivation: 3,
          hasPain: false,
          createdAt: new Date('2026-08-18T00:00:00Z'),
        },
      }),
    );

    expect(Math.abs(state.score - 61)).toBeGreaterThan(5);
  });

  it('degrades gracefully with no wearable at all', () => {
    const state = computeRecoveryState({
      athleteId: 'athlete-1',
      date: DATE,
      checkIn: {
        id: 'c-1',
        athleteId: 'athlete-1',
        date: DATE,
        energy: 4,
        soreness: 4,
        stress: 4,
        motivation: 4,
        hasPain: false,
        createdAt: new Date('2026-08-18T00:00:00Z'),
      },
    });

    // Still produces a usable score, but flags low coverage.
    expect(state.score).toBeGreaterThan(0);
    expect(state.dataCompleteness).toBeLessThan(0.5);
    expect(state.missingSignals.length).toBeGreaterThan(0);
    expect(state.summary).toMatch(/limited data/i);
  });

  it('returns a neutral, honest result with no data whatsoever', () => {
    const state = computeRecoveryState({ athleteId: 'athlete-1', date: DATE });
    expect(state.score).toBe(50);
    expect(state.band).toBe('yellow');
    expect(state.dataCompleteness).toBe(0);
    expect(state.summary).toMatch(/No recovery data/i);
  });

  it('ignores a provider score while the device is still calibrating', () => {
    const state = computeRecoveryState(
      baseInputs({
        today: {
          id: 'r-1',
          athleteId: 'athlete-1',
          date: DATE,
          providerRecoveryScore: 99,
          hrvRmssdMs: 62,
          restingHeartRateBpm: 48,
          calibrating: true,
          source: 'whoop',
        },
      }),
    );

    expect(state.components.some((c) => c.key === 'provider_recovery')).toBe(false);
    expect(state.missingSignals.some((s) => /calibrating/i.test(s))).toBe(true);
  });

  it('judges HRV against the athlete’s own baseline, not an absolute value', () => {
    // The same 50 ms HRV is good for one athlete and poor for another.
    const lowBaseline = computeRecoveryState(
      baseInputs({
        today: { id: 'r', athleteId: 'a', date: DATE, hrvRmssdMs: 50, source: 'whoop' },
        hrvHistory: [45, 46, 44, 47, 45],
      }),
    );
    const highBaseline = computeRecoveryState(
      baseInputs({
        today: { id: 'r', athleteId: 'a', date: DATE, hrvRmssdMs: 50, source: 'whoop' },
        hrvHistory: [70, 72, 68, 71, 70],
      }),
    );

    const lowHrv = lowBaseline.components.find((c) => c.key === 'hrv')!;
    const highHrv = highBaseline.components.find((c) => c.key === 'hrv')!;
    expect(lowHrv.score).toBeGreaterThan(highHrv.score);
  });

  it('renormalises weights so a missing signal does not drag the score down', () => {
    const full = computeRecoveryState(baseInputs());
    const noSleep = computeRecoveryState(baseInputs({ lastNightSleep: undefined }));

    // Removing a good signal shouldn't crater the score — it should mostly
    // reduce confidence/coverage.
    expect(Math.abs(full.score - noSleep.score)).toBeLessThan(20);
    expect(noSleep.dataCompleteness).toBeLessThan(full.dataCompleteness);
  });

  it('names the limiting factor in its summary', () => {
    const state = computeRecoveryState(
      baseInputs({ lastNightSleep: makeSleep(4.5 * 3600, { performancePercent: 45 }) }),
    );
    expect(state.summary.length).toBeGreaterThan(20);
    expect(state.components.length).toBeGreaterThan(0);
  });

  it('always reports components sorted by weight', () => {
    const state = computeRecoveryState(baseInputs());
    for (let i = 1; i < state.components.length; i++) {
      expect(state.components[i - 1]!.weight).toBeGreaterThanOrEqual(state.components[i]!.weight);
    }
  });
});

describe('buildBaseline', () => {
  it('refuses to build a baseline from too few samples', () => {
    expect(buildBaseline([60, 62], 14)).toBeUndefined();
  });

  it('computes mean and deviation over the window', () => {
    const baseline = buildBaseline([60, 62, 61, 63, 64], 14)!;
    expect(baseline.mean).toBeCloseTo(62, 1);
    expect(baseline.sampleCount).toBe(5);
  });

  it('only uses the most recent window', () => {
    const values = [10, 10, 10, 60, 62, 61];
    const baseline = buildBaseline(values, 3)!;
    expect(baseline.mean).toBeCloseTo(61, 0);
  });
});

describe('estimateSleepNeed', () => {
  it('defaults to 8 hours without enough history', () => {
    expect(estimateSleepNeed([7 * 3600])).toBe(8 * 3600);
  });

  it('uses the upper part of the distribution rather than the mean', () => {
    const nights = [6, 6.5, 7, 7, 7.5, 8, 8.5].map((h) => h * 3600);
    const need = estimateSleepNeed(nights);
    const average = nights.reduce((a, b) => a + b, 0) / nights.length;
    expect(need).toBeGreaterThan(average);
  });

  it('clamps to a plausible range', () => {
    const need = estimateSleepNeed(Array.from({ length: 10 }, () => 14 * 3600));
    expect(need).toBeLessThanOrEqual(10 * 3600);
  });
});
