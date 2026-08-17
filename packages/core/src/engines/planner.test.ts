import { describe, expect, it } from 'vitest';
import { findPlanPosition, generateTrainingPlan, weeksUntil, type PlanGenerationInputs } from './planner.js';
import { estimateFitness } from './fitness.js';
import { isHardType } from '../domain/workout.js';
import { daysBetweenLocalDates, startOfWeek } from '../util/time.js';
import { makeAthlete } from '../__fixtures__/index.js';

const FITNESS = estimateFitness(
  [{ distanceMeters: 5000, durationSeconds: 1540, date: '2026-08-01', source: 'race' }],
  '2026-08-17',
);

function makeIdFactory(): (kind: 'plan' | 'block' | 'workout') => string {
  const counters = { plan: 0, block: 0, workout: 0 };
  return (kind) => `${kind}-${++counters[kind]}`;
}

function baseInputs(overrides: Partial<PlanGenerationInputs> = {}): PlanGenerationInputs {
  const athlete = makeAthlete();
  return {
    athleteId: 'athlete-1',
    template: 'road_10k',
    startDate: '2026-08-17',
    totalWeeks: 12,
    availability: athlete.availability,
    constraints: athlete.constraints,
    fitness: FITNESS,
    currentWeeklyDistanceMeters: 30000,
    longestRecentRunMeters: 14000,
    idFactory: makeIdFactory(),
    now: new Date('2026-08-17T00:00:00Z'),
    ...overrides,
  };
}

describe('generateTrainingPlan structure', () => {
  it('produces blocks covering exactly the requested number of weeks', () => {
    const plan = generateTrainingPlan(baseInputs({ totalWeeks: 12 }));
    const totalBlockWeeks = plan.blocks.reduce((acc, b) => acc + b.durationWeeks, 0);
    expect(totalBlockWeeks).toBe(12);
  });

  it('starts on a Monday', () => {
    const plan = generateTrainingPlan(baseInputs({ startDate: '2026-08-19' }));
    expect(plan.startDate).toBe(startOfWeek(plan.startDate));
  });

  it('orders blocks base -> build -> specific -> taper', () => {
    const plan = generateTrainingPlan(baseInputs());
    const types = plan.blocks.map((b) => b.type);
    expect(types[0]).toBe('base');
    expect(types[types.length - 1]).toBe('taper');
  });

  it('leaves no gaps or overlaps between blocks', () => {
    const plan = generateTrainingPlan(baseInputs());
    for (let i = 1; i < plan.blocks.length; i++) {
      const previous = plan.blocks[i - 1]!;
      const current = plan.blocks[i]!;
      expect(daysBetweenLocalDates(previous.endDate, current.startDate)).toBe(1);
    }
  });

  it('handles a very short plan without dropping blocks below one week', () => {
    const plan = generateTrainingPlan(baseInputs({ totalWeeks: 4 }));
    expect(plan.blocks.length).toBeGreaterThan(0);
    expect(plan.blocks.every((b) => b.durationWeeks >= 1)).toBe(true);
    expect(plan.blocks.reduce((a, b) => a + b.durationWeeks, 0)).toBe(4);
  });
});

describe('volume progression', () => {
  it('anchors week one to the athlete’s actual current volume', () => {
    const plan = generateTrainingPlan(baseInputs({ currentWeeklyDistanceMeters: 30000 }));
    expect(plan.generationBasis.weeklyDistanceMetersAtStart).toBeCloseTo(30000, -3);
  });

  it('never exceeds the highest volume reached so far by more than the cap', () => {
    // This is the safety-relevant invariant. A week-on-week comparison would
    // be wrong: rebounding out of a deload legitimately jumps ~50%, because it
    // returns to a volume the athlete already handled. What must never happen
    // is the plan pushing past the athlete's established ceiling in one step.
    const plan = generateTrainingPlan(baseInputs());
    const volumes = plan.blocks.flatMap((b) => b.weeklyDistanceTargetsMeters);

    let peakSoFar = volumes[0]!;
    for (let i = 1; i < volumes.length; i++) {
      const current = volumes[i]!;
      // 0.11 rather than 0.10 absorbs integer rounding on the metre values.
      expect(current).toBeLessThanOrEqual(peakSoFar * 1.11);
      peakSoFar = Math.max(peakSoFar, current);
    }
  });

  it('grows the underlying build trend no faster than the cap', () => {
    // Ignoring deload dips, consecutive build weeks must respect the cap.
    const plan = generateTrainingPlan(baseInputs());
    const volumes = plan.blocks.flatMap((b) => b.weeklyDistanceTargetsMeters);

    const buildPeaks = volumes.filter((v, i) => i === 0 || v >= volumes[i - 1]!);
    for (let i = 1; i < buildPeaks.length; i++) {
      const previous = buildPeaks[i - 1]!;
      const current = buildPeaks[i]!;
      if (current <= previous) continue;
      expect((current - previous) / previous).toBeLessThanOrEqual(0.11);
    }
  });

  it('includes deload weeks where volume steps down', () => {
    const plan = generateTrainingPlan(baseInputs({ totalWeeks: 12 }));
    const volumes = plan.blocks.flatMap((b) => b.weeklyDistanceTargetsMeters);
    const stepDowns = volumes.filter((v, i) => i > 0 && v < volumes[i - 1]!);
    expect(stepDowns.length).toBeGreaterThan(0);
  });

  it('tapers into the final week', () => {
    const plan = generateTrainingPlan(baseInputs({ totalWeeks: 12 }));
    const volumes = plan.blocks.flatMap((b) => b.weeklyDistanceTargetsMeters);
    const peak = Math.max(...volumes);
    expect(volumes[volumes.length - 1]!).toBeLessThan(peak);
  });

  it('does not start a beginner at an unrealistic volume', () => {
    const plan = generateTrainingPlan(
      baseInputs({ template: 'beginner_5k', currentWeeklyDistanceMeters: 0, totalWeeks: 8 }),
    );
    const firstWeek = plan.blocks[0]!.weeklyDistanceTargetsMeters[0]!;
    expect(firstWeek).toBeLessThan(15000);
    expect(plan.generationBasis.notes.some((n) => /conservative default/i.test(n))).toBe(true);
  });
});

describe('session scheduling', () => {
  it('schedules the long run on the athlete’s chosen day', () => {
    // Fixture athlete has longRunDay = 0 (Sunday).
    const plan = generateTrainingPlan(baseInputs());
    const longRuns = plan.workouts.filter((w) => w.type === 'long');
    expect(longRuns.length).toBeGreaterThan(0);

    for (const run of longRuns) {
      const dow = new Date(`${run.date}T12:00:00Z`).getUTCDay();
      expect(dow).toBe(0);
    }
  });

  it('never schedules a session on a declared rest day', () => {
    // Fixture athlete rests on Wednesday (3) and Friday (5).
    const plan = generateTrainingPlan(baseInputs());
    for (const workout of plan.workouts) {
      const dow = new Date(`${workout.date}T12:00:00Z`).getUTCDay();
      expect([3, 5]).not.toContain(dow);
    }
  });

  it('respects explicitly unavailable dates', () => {
    const athlete = makeAthlete();
    const blocked = '2026-08-18';
    const plan = generateTrainingPlan(
      baseInputs({
        constraints: { ...athlete.constraints, unavailableDates: [blocked] },
      }),
    );
    expect(plan.workouts.some((w) => w.date === blocked)).toBe(false);
  });

  it('never schedules hard sessions on consecutive days', () => {
    const plan = generateTrainingPlan(baseInputs());
    const hardDates = plan.workouts
      .filter((w) => isHardType(w.type))
      .map((w) => w.date)
      .sort();

    for (let i = 1; i < hardDates.length; i++) {
      const gap = daysBetweenLocalDates(hardDates[i - 1]!, hardDates[i]!);
      expect(gap).not.toBe(1);
    }
  });

  it('respects the athlete’s maximum sessions per week', () => {
    const athlete = makeAthlete();
    const plan = generateTrainingPlan(
      baseInputs({
        availability: { ...athlete.availability, maxSessionsPerWeek: 3, runDays: [1, 2, 4, 6, 0] },
      }),
    );

    const byWeek = new Map<string, number>();
    for (const workout of plan.workouts) {
      const week = startOfWeek(workout.date);
      byWeek.set(week, (byWeek.get(week) ?? 0) + 1);
    }
    for (const count of byWeek.values()) {
      expect(count).toBeLessThanOrEqual(3);
    }
  });

  it('gives every session a stated purpose', () => {
    const plan = generateTrainingPlan(baseInputs());
    for (const workout of plan.workouts) {
      expect(workout.purpose.length).toBeGreaterThan(5);
      expect(workout.title.length).toBeGreaterThan(0);
    }
  });

  it('attaches concrete structure to interval sessions', () => {
    const plan = generateTrainingPlan(baseInputs());
    const intervals = plan.workouts.find((w) => w.type === 'intervals');
    if (intervals) {
      expect(intervals.structure).toBeDefined();
      expect(intervals.structure!.warmup).toBeDefined();
      expect(intervals.structure!.main.length).toBeGreaterThan(0);
      expect(intervals.structure!.cooldown).toBeDefined();
    }
  });

  it('produces no sessions when the athlete has no available days', () => {
    const athlete = makeAthlete();
    const plan = generateTrainingPlan(
      baseInputs({
        availability: { ...athlete.availability, runDays: [], maxSessionsPerWeek: 0 },
      }),
    );
    expect(plan.workouts).toHaveLength(0);
    expect(plan.generationBasis.notes.some((n) => /no available training days/i.test(n))).toBe(true);
  });
});

describe('race-targeted plans', () => {
  it('places a race session on race day', () => {
    const raceDate = '2026-11-08';
    const plan = generateTrainingPlan(
      baseInputs({
        startDate: '2026-08-17',
        totalWeeks: weeksUntil('2026-08-17', raceDate),
        raceDate,
        raceDistanceMeters: 10000,
        raceGoalId: 'race-1',
      }),
    );

    const race = plan.workouts.find((w) => w.type === 'race');
    expect(race).toBeDefined();
    expect(race!.date).toBe(raceDate);
  });

  it('keeps race week easy apart from the race itself', () => {
    const raceDate = '2026-11-08';
    const plan = generateTrainingPlan(
      baseInputs({
        totalWeeks: weeksUntil('2026-08-17', raceDate),
        raceDate,
        raceDistanceMeters: 10000,
      }),
    );

    const raceWeek = startOfWeek(raceDate);
    const sessions = plan.workouts.filter((w) => startOfWeek(w.date) === raceWeek);
    for (const session of sessions) {
      expect(['race', 'easy', 'recovery']).toContain(session.type);
    }
  });
});

describe('determinism and explainability', () => {
  it('produces identical plans for identical inputs', () => {
    const a = generateTrainingPlan(baseInputs({ idFactory: makeIdFactory() }));
    const b = generateTrainingPlan(baseInputs({ idFactory: makeIdFactory() }));

    expect(a.workouts.map((w) => `${w.date}:${w.type}:${w.targetDistanceMeters}`)).toEqual(
      b.workouts.map((w) => `${w.date}:${w.type}:${w.targetDistanceMeters}`),
    );
  });

  it('records the basis it generated from', () => {
    const plan = generateTrainingPlan(baseInputs());
    expect(plan.generationBasis.notes.length).toBeGreaterThan(0);
    expect(plan.generationBasis.sessionsPerWeek).toBeGreaterThan(0);
  });
});

describe('findPlanPosition', () => {
  it('locates the current block and week', () => {
    const plan = generateTrainingPlan(baseInputs({ startDate: '2026-08-17', totalWeeks: 12 }));
    const position = findPlanPosition(plan, '2026-08-20')!;

    expect(position.block.type).toBe('base');
    expect(position.weekInBlock).toBe(1);
    expect(position.weekInPlan).toBe(1);
    expect(position.weeklyTargetMeters).toBeGreaterThan(0);
  });

  it('returns undefined for a date outside the plan', () => {
    const plan = generateTrainingPlan(baseInputs());
    expect(findPlanPosition(plan, '2025-01-01')).toBeUndefined();
  });
});

describe('weeksUntil', () => {
  it('rounds partial weeks up', () => {
    expect(weeksUntil('2026-08-17', '2026-08-31')).toBe(2);
    expect(weeksUntil('2026-08-17', '2026-09-01')).toBe(3);
  });

  it('never returns less than one week', () => {
    expect(weeksUntil('2026-08-17', '2026-08-17')).toBe(1);
  });
});
