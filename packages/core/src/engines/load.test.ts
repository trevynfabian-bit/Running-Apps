import { describe, expect, it } from 'vitest';
import {
  computeIntensityDistribution,
  computeSessionLoad,
  computeTrainingLoadState,
  sessionRpeLoad,
  toDailySeries,
  trimp,
} from './load.js';
import { makeCanonicalWorkout, makeDailyLoads } from '../__fixtures__/index.js';

describe('trimp', () => {
  it('increases with both duration and intensity', () => {
    const short = trimp(30, 150, 190, 50, 'male')!;
    const long = trimp(60, 150, 190, 50, 'male')!;
    const hard = trimp(30, 175, 190, 50, 'male')!;

    expect(long).toBeGreaterThan(short);
    expect(hard).toBeGreaterThan(short);
  });

  it('scales linearly in duration', () => {
    const a = trimp(30, 150, 190, 50, 'male')!;
    const b = trimp(60, 150, 190, 50, 'male')!;
    expect(b / a).toBeCloseTo(2, 5);
  });

  it('uses the midpoint coefficient for unspecified sex rather than defaulting to male', () => {
    const male = trimp(45, 160, 190, 50, 'male')!;
    const female = trimp(45, 160, 190, 50, 'female')!;
    const unspecified = trimp(45, 160, 190, 50, 'unspecified')!;

    expect(unspecified).toBeGreaterThan(female);
    expect(unspecified).toBeLessThan(male);
  });

  it('returns zero when heart rate is at or below resting', () => {
    expect(trimp(30, 50, 190, 50, 'male')).toBe(0);
  });

  it('returns undefined for a degenerate heart-rate reserve', () => {
    expect(trimp(30, 150, 150, 150, 'male')).toBeUndefined();
  });
});

describe('computeSessionLoad model selection', () => {
  it('prefers TRIMP when heart rate and both anchors are present', () => {
    const load = computeSessionLoad(makeCanonicalWorkout(), {
      sex: 'male',
      maxHeartRateBpm: 190,
      restingHeartRateBpm: 50,
    })!;
    expect(load.model).toBe('trimp_hr');
    expect(load.confidence).toBeGreaterThan(0.8);
  });

  it('falls back to session RPE when heart rate is missing', () => {
    const workout = makeCanonicalWorkout({
      avgHeartRateBpm: undefined,
      perceivedExertion: 6,
    });
    const load = computeSessionLoad(workout, { sex: 'male' })!;
    expect(load.model).toBe('srpe');
    expect(load.load).toBeCloseTo(sessionRpeLoad(45, 6), 5);
  });

  it('falls back to duration × type intensity as a last resort', () => {
    const workout = makeCanonicalWorkout({
      avgHeartRateBpm: undefined,
      perceivedExertion: undefined,
    });
    const load = computeSessionLoad(workout, { sex: 'male' })!;
    expect(load.model).toBe('duration');
    // Flagged as low confidence so the UI can caveat it.
    expect(load.confidence).toBeLessThan(0.5);
  });

  it('scores a rest day as zero load', () => {
    const load = computeSessionLoad(makeCanonicalWorkout({ type: 'rest' }), { sex: 'male' })!;
    expect(load.load).toBe(0);
  });

  it('gives intervals more load than an easy run of the same duration', () => {
    const easy = computeSessionLoad(
      makeCanonicalWorkout({ type: 'easy', avgHeartRateBpm: undefined }),
      { sex: 'male' },
    )!;
    const intervals = computeSessionLoad(
      makeCanonicalWorkout({ type: 'intervals', avgHeartRateBpm: undefined }),
      { sex: 'male' },
    )!;
    expect(intervals.load).toBeGreaterThan(easy.load);
  });

  it('returns undefined for a workout with no duration', () => {
    const workout = makeCanonicalWorkout({ durationSeconds: 0, movingTimeSeconds: 0 });
    expect(computeSessionLoad(workout, { sex: 'male' })).toBeUndefined();
  });

  it('always states the basis of its computation', () => {
    const load = computeSessionLoad(makeCanonicalWorkout(), {
      sex: 'male',
      maxHeartRateBpm: 190,
      restingHeartRateBpm: 50,
    })!;
    expect(load.basis).toMatch(/TRIMP/);
  });
});

describe('toDailySeries', () => {
  it('fills rest days with zero rather than skipping them', () => {
    const series = toDailySeries(
      [
        { workoutId: 'a', date: '2026-08-10', load: 50, model: 'trimp_hr', confidence: 1, basis: '' },
        { workoutId: 'b', date: '2026-08-12', load: 70, model: 'trimp_hr', confidence: 1, basis: '' },
      ],
      '2026-08-10',
      '2026-08-13',
    );

    expect(series).toHaveLength(4);
    expect(series.map((d) => d.load)).toEqual([50, 0, 70, 0]);
  });

  it('sums two sessions on the same day', () => {
    const series = toDailySeries(
      [
        { workoutId: 'a', date: '2026-08-10', load: 50, model: 'srpe', confidence: 1, basis: '' },
        { workoutId: 'b', date: '2026-08-10', load: 30, model: 'srpe', confidence: 1, basis: '' },
      ],
      '2026-08-10',
      '2026-08-10',
    );
    expect(series[0]!.load).toBe(80);
  });
});

describe('computeTrainingLoadState', () => {
  // A realistic 6-week block: hard Tue, long Sun, rest Wed/Fri.
  const pattern = [60, 45, 0, 70, 0, 40, 110];
  const daily = makeDailyLoads('2026-07-06', 6, pattern);

  it('computes acute and chronic load', () => {
    const state = computeTrainingLoadState(daily)!;
    expect(state.acuteLoad).toBeGreaterThan(0);
    expect(state.chronicLoad).toBeGreaterThan(0);
  });

  it('reports an acute:chronic ratio once there is enough history', () => {
    const state = computeTrainingLoadState(daily)!;
    expect(state.acuteChronicRatio).toBeDefined();
    // A steady block should sit near 1.0.
    expect(state.acuteChronicRatio!).toBeGreaterThan(0.7);
    expect(state.acuteChronicRatio!).toBeLessThan(1.4);
  });

  it('suppresses the ratio when history is too thin to support it', () => {
    // Five days is nowhere near enough chronic base.
    const thin = makeDailyLoads('2026-08-10', 1, pattern).slice(0, 5);
    const state = computeTrainingLoadState(thin)!;
    expect(state.acuteChronicRatio).toBeUndefined();
  });

  it('detects a load spike as an elevated ratio', () => {
    const spiked = [...daily];
    for (let i = spiked.length - 7; i < spiked.length; i++) {
      spiked[i] = { ...spiked[i]!, load: spiked[i]!.load * 2.5 };
    }
    const baseline = computeTrainingLoadState(daily)!;
    const spike = computeTrainingLoadState(spiked)!;
    expect(spike.acuteChronicRatio!).toBeGreaterThan(baseline.acuteChronicRatio!);
  });

  it('computes monotony and strain over a full week', () => {
    const state = computeTrainingLoadState(daily)!;
    expect(state.monotony).toBeDefined();
    expect(state.strain).toBeCloseTo(state.weeklyLoad * state.monotony!, 5);
  });

  it('suppresses monotony when every day is identical (degenerate variance)', () => {
    const flat = makeDailyLoads('2026-07-06', 4, [50, 50, 50, 50, 50, 50, 50]);
    const state = computeTrainingLoadState(flat)!;
    expect(state.monotony).toBeUndefined();
  });

  it('returns undefined for an empty series', () => {
    expect(computeTrainingLoadState([])).toBeUndefined();
  });
});

describe('computeIntensityDistribution', () => {
  it('flags an easy share below the 75% guideline', () => {
    const workouts = [
      makeCanonicalWorkout({ id: '1', type: 'threshold', durationSeconds: 3600 }),
      makeCanonicalWorkout({ id: '2', type: 'intervals', durationSeconds: 3600 }),
      makeCanonicalWorkout({ id: '3', type: 'easy', durationSeconds: 1800 }),
    ];
    const distribution = computeIntensityDistribution(workouts)!;
    expect(distribution.easyShareBelowGuideline).toBe(true);
    expect(distribution.easyShare).toBeLessThan(0.75);
  });

  it('does not flag a well-balanced week', () => {
    const workouts = [
      makeCanonicalWorkout({ id: '1', type: 'easy', durationSeconds: 3600 }),
      makeCanonicalWorkout({ id: '2', type: 'easy', durationSeconds: 3600 }),
      makeCanonicalWorkout({ id: '3', type: 'long', durationSeconds: 5400 }),
      makeCanonicalWorkout({ id: '4', type: 'intervals', durationSeconds: 2400 }),
    ];
    const distribution = computeIntensityDistribution(workouts)!;
    expect(distribution.easyShareBelowGuideline).toBe(false);
  });

  it('ignores rest days', () => {
    const workouts = [
      makeCanonicalWorkout({ id: '1', type: 'easy', durationSeconds: 3600 }),
      makeCanonicalWorkout({ id: '2', type: 'rest', durationSeconds: 0 }),
    ];
    const distribution = computeIntensityDistribution(workouts)!;
    expect(distribution.totalSeconds).toBe(3600);
  });

  it('returns undefined when there is nothing to measure', () => {
    expect(computeIntensityDistribution([])).toBeUndefined();
  });
});
