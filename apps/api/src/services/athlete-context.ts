/**
 * Athlete context assembly.
 *
 * One place that loads everything the engines need about an athlete, so the
 * dashboard, the coach and the review generator all reason over exactly the
 * same picture. Assembling this twice in two slightly different ways is how a
 * product ends up telling the athlete two different things on two screens.
 */

import { and, desc, eq, gte, lte } from 'drizzle-orm';

import {
  addDaysToLocalDate,
  assessTrainingState,
  buildWeeklySummary,
  comparableEfficiencyPoints,
  computeHeartRateZones,
  computeIntensityDistribution,
  computeRecoveryState,
  computeTrainingLoadState,
  daysBetweenLocalDates,
  efficiencyTrend,
  estimateFitness,
  estimateMaxHeartRate,
  estimateSleepNeed,
  ageInYears,
  isHardType,
  predictRace,
  selectHeartRateMethodology,
  startOfWeek,
  toEfficiencyPoint,
  toLocalDate,
  type CanonicalWorkout,
  type EfficiencyTrend,
  type FitnessEstimate,
  type FitnessInput,
  type RecoveryRecord,
  type RecoveryState,
  type SleepRecord,
  type SubjectiveCheckIn,
  type TrainingLoadState,
  type TrainingStateAssessment,
  type ZoneSet,
  type ZoneMethodology,
} from '@running/core';

import { getDb } from '../db/client.js';
import {
  athleteProfiles,
  bodyMeasurements,
  canonicalWorkouts,
  checkIns,
  plannedWorkouts,
  raceGoals,
  raceResults,
  recoveryStates,
  trainingBlocks,
  trainingPlans,
  whoopRecoveries,
  whoopSleep,
} from '../db/schema.js';
import { rowToCanonicalWorkout } from '../sync/engine.js';
import { notFound } from '../errors.js';

export interface AthleteContext {
  profile: typeof athleteProfiles.$inferSelect;
  timezone: string;
  today: string;

  workouts: CanonicalWorkout[];
  recentRuns: CanonicalWorkout[];

  recoveryRecords: RecoveryRecord[];
  sleepRecords: SleepRecord[];
  checkIn?: SubjectiveCheckIn;
  recentCheckIns: SubjectiveCheckIn[];

  recovery: RecoveryState;
  recentRecoveryStates: RecoveryState[];
  loadState?: TrainingLoadState;
  trainingState: TrainingStateAssessment;

  fitness: FitnessEstimate;
  efficiency?: EfficiencyTrend;
  zones?: ZoneSet;

  maxHeartRateBpm?: number;
  restingHeartRateBpm?: number;
  weightKilograms?: number;

  plan?: {
    plan: typeof trainingPlans.$inferSelect;
    blocks: (typeof trainingBlocks.$inferSelect)[];
    upcoming: (typeof plannedWorkouts.$inferSelect)[];
    todayWorkout?: typeof plannedWorkouts.$inferSelect;
    weekWorkouts: (typeof plannedWorkouts.$inferSelect)[];
  };

  nextRace?: typeof raceGoals.$inferSelect;
  weeklyDistanceMeters: number[];
  daysSinceLastRun?: number;
  recentHardSessionDates: string[];
}

const HISTORY_DAYS = 120;

export async function loadAthleteContext(
  athleteId: string,
  options: { today?: string } = {},
): Promise<AthleteContext> {
  const { db } = await getDb();

  const [profile] = await db
    .select()
    .from(athleteProfiles)
    .where(eq(athleteProfiles.id, athleteId))
    .limit(1);

  if (!profile) throw notFound('Athlete');

  const timezone = profile.timezone || 'UTC';
  const today = options.today ?? toLocalDate(new Date(), timezone);
  const historyStart = addDaysToLocalDate(today, -HISTORY_DAYS);
  const historyStartInstant = new Date(`${historyStart}T00:00:00Z`);

  // --- Workouts ------------------------------------------------------------
  const workoutRows = await db
    .select()
    .from(canonicalWorkouts)
    .where(
      and(
        eq(canonicalWorkouts.athleteId, athleteId),
        gte(canonicalWorkouts.startTime, historyStartInstant),
      ),
    )
    .orderBy(canonicalWorkouts.startTime);

  const workouts = workoutRows.map(rowToCanonicalWorkout);
  const recentRuns = workouts.filter((w) => w.sport === 'run');

  // --- Physiology ----------------------------------------------------------
  const recoveryRows = await db
    .select()
    .from(whoopRecoveries)
    .where(
      and(eq(whoopRecoveries.athleteId, athleteId), gte(whoopRecoveries.localDate, historyStart)),
    )
    .orderBy(whoopRecoveries.localDate);

  const recoveryRecords: RecoveryRecord[] = recoveryRows.map((row) => ({
    id: row.id,
    athleteId,
    date: row.localDate,
    providerRecoveryScore: row.recoveryScore ?? undefined,
    hrvRmssdMs: row.hrvRmssdMilli ?? undefined,
    restingHeartRateBpm: row.restingHeartRate ?? undefined,
    spo2Percent: row.spo2Percentage ?? undefined,
    skinTempCelsius: row.skinTempCelsius ?? undefined,
    calibrating: row.userCalibrating ?? undefined,
    source: 'whoop',
  }));

  const sleepRows = await db
    .select()
    .from(whoopSleep)
    .where(and(eq(whoopSleep.athleteId, athleteId), gte(whoopSleep.localDate, historyStart)))
    .orderBy(whoopSleep.localDate);

  const sleepRecords: SleepRecord[] = sleepRows
    .filter((row) => !row.nap)
    .map((row) => ({
      id: row.id,
      athleteId,
      date: row.localDate,
      start: row.start,
      end: row.end,
      totalSleepSeconds: Math.round(
        ((row.totalLightSleepTimeMilli ?? 0) +
          (row.totalSlowWaveSleepTimeMilli ?? 0) +
          (row.totalRemSleepTimeMilli ?? 0)) /
          1000,
      ),
      timeInBedSeconds: row.totalInBedTimeMilli ? row.totalInBedTimeMilli / 1000 : undefined,
      lightSleepSeconds: row.totalLightSleepTimeMilli
        ? row.totalLightSleepTimeMilli / 1000
        : undefined,
      deepSleepSeconds: row.totalSlowWaveSleepTimeMilli
        ? row.totalSlowWaveSleepTimeMilli / 1000
        : undefined,
      remSleepSeconds: row.totalRemSleepTimeMilli ? row.totalRemSleepTimeMilli / 1000 : undefined,
      awakeSeconds: row.totalAwakeTimeMilli ? row.totalAwakeTimeMilli / 1000 : undefined,
      performancePercent: row.sleepPerformancePercentage ?? undefined,
      consistencyPercent: row.sleepConsistencyPercentage ?? undefined,
      efficiencyPercent: row.sleepEfficiencyPercentage ?? undefined,
      respiratoryRate: row.respiratoryRate ?? undefined,
      disturbanceCount: row.disturbanceCount ?? undefined,
      isNap: false,
      source: 'whoop',
    }));

  // --- Check-ins -----------------------------------------------------------
  const checkInRows = await db
    .select()
    .from(checkIns)
    .where(and(eq(checkIns.athleteId, athleteId), gte(checkIns.date, historyStart)))
    .orderBy(desc(checkIns.date));

  const recentCheckIns: SubjectiveCheckIn[] = checkInRows.map((row) => ({
    id: row.id,
    athleteId,
    date: row.date,
    energy: row.energy,
    soreness: row.soreness,
    stress: row.stress,
    motivation: row.motivation,
    hasPain: row.hasPain,
    painNote: row.painNote ?? undefined,
    createdAt: row.createdAt,
  }));
  const checkIn = recentCheckIns.find((c) => c.date === today);

  // --- Body metrics --------------------------------------------------------
  const measurements = await db
    .select()
    .from(bodyMeasurements)
    .where(eq(bodyMeasurements.athleteId, athleteId))
    .orderBy(desc(bodyMeasurements.measuredAt));

  const latest = (metric: string): number | undefined =>
    measurements.find((m) => m.metric === metric)?.normalizedValue;

  const age = profile.dateOfBirth ? ageInYears(profile.dateOfBirth) : undefined;
  const maxHeartRateBpm =
    profile.maxHeartRateBpm ??
    latest('max_hr') ??
    (age !== undefined ? estimateMaxHeartRate(age) : undefined);
  const restingHeartRateBpm =
    profile.restingHeartRateBpm ??
    latest('resting_hr') ??
    // Fall back to the most recent measured resting HR from the wearable.
    recoveryRecords[recoveryRecords.length - 1]?.restingHeartRateBpm;

  // --- Training load -------------------------------------------------------
  const loadState = computeLoadState(workouts, today, timezone);

  // --- Recovery ------------------------------------------------------------
  const todayRecovery = recoveryRecords.find((r) => r.date === today);
  const yesterdaySleep = sleepRecords.find((s) => s.date === today);
  const priorRecoveries = recoveryRecords.filter((r) => r.date < today);

  const recovery = computeRecoveryState({
    athleteId,
    date: today,
    today: todayRecovery,
    lastNightSleep: yesterdaySleep,
    checkIn,
    loadState,
    hrvHistory: priorRecoveries.map((r) => r.hrvRmssdMs).filter((v): v is number => v !== undefined),
    restingHrHistory: priorRecoveries
      .map((r) => r.restingHeartRateBpm)
      .filter((v): v is number => v !== undefined),
    sleepNeedSeconds: estimateSleepNeed(sleepRecords.map((s) => s.totalSleepSeconds)),
  });

  // Historical recovery states, for trend and training-state assessment.
  const storedStates = await db
    .select()
    .from(recoveryStates)
    .where(and(eq(recoveryStates.athleteId, athleteId), gte(recoveryStates.date, historyStart)))
    .orderBy(recoveryStates.date);

  const recentRecoveryStates: RecoveryState[] = storedStates.map((row) => ({
    athleteId,
    date: row.date,
    score: row.score,
    band: row.band as RecoveryState['band'],
    components: (row.components as RecoveryState['components']) ?? [],
    missingSignals: (row.missingSignals as string[]) ?? [],
    dataCompleteness: row.dataCompleteness,
    summary: row.summary,
  }));

  // --- Fitness -------------------------------------------------------------
  const raceResultRows = await db
    .select()
    .from(raceResults)
    .where(eq(raceResults.athleteId, athleteId))
    .orderBy(desc(raceResults.date));

  const fitnessInputs: FitnessInput[] = raceResultRows.map((row) => ({
    distanceMeters: row.distanceMeters,
    durationSeconds: row.durationSeconds,
    date: row.date,
    source:
      row.source === 'detected'
        ? 'detected_effort'
        : row.source === 'time_trial'
          ? 'time_trial'
          : row.source === 'race'
            ? 'race'
            : 'self_reported',
  }));

  // Hard efforts detected in training also inform fitness, at lower weight.
  for (const run of recentRuns) {
    if (
      (run.type === 'race' || run.type === 'time_trial') &&
      run.distanceMeters &&
      run.movingTimeSeconds
    ) {
      fitnessInputs.push({
        distanceMeters: run.distanceMeters,
        durationSeconds: run.movingTimeSeconds,
        date: toLocalDate(run.startTime, run.timezone),
        source: 'detected_effort',
      });
    }
  }

  const fitness = estimateFitness(fitnessInputs, today);

  // --- Zones ---------------------------------------------------------------
  let zones: ZoneSet | undefined;
  if (maxHeartRateBpm) {
    const thresholdHr = profile.thresholdHeartRateBpm ?? undefined;
    const methodology = selectHeartRateMethodology(
      (profile.zoneMethodology as ZoneMethodology) ?? 'hr_reserve',
      { maxHeartRateBpm, restingHeartRateBpm, thresholdHeartRateBpm: thresholdHr },
    );
    zones = computeHeartRateZones(methodology, {
      maxHeartRateBpm,
      restingHeartRateBpm,
      thresholdHeartRateBpm: thresholdHr,
    });
  }

  // --- Aerobic efficiency --------------------------------------------------
  const efficiencyPoints = comparableEfficiencyPoints(
    recentRuns.map(toEfficiencyPoint).filter((p): p is NonNullable<typeof p> => p !== undefined),
  );
  const efficiency = efficiencyTrend(efficiencyPoints);

  // --- Weekly volume history ----------------------------------------------
  const weeklyDistanceMeters = computeWeeklyDistances(recentRuns, timezone, today, 12);

  const lastRun = recentRuns[recentRuns.length - 1];
  const daysSinceLastRun = lastRun
    ? daysBetweenLocalDates(toLocalDate(lastRun.startTime, lastRun.timezone), today)
    : undefined;

  const recentHardSessionDates = recentRuns
    .filter((w) => isHardType(w.type))
    .map((w) => toLocalDate(w.startTime, w.timezone))
    .filter((d) => daysBetweenLocalDates(d, today) <= 14 && daysBetweenLocalDates(d, today) >= 0)
    .sort((a, b) => b.localeCompare(a));

  // --- Consecutive low-energy days ----------------------------------------
  let consecutiveLowEnergyDays = 0;
  for (let i = 0; i < 7; i++) {
    const date = addDaysToLocalDate(today, -i);
    const entry = recentCheckIns.find((c) => c.date === date);
    if (entry && entry.energy <= 2) consecutiveLowEnergyDays++;
    else if (entry) break;
  }

  const trainingState = assessTrainingState({
    loadState,
    recentRecovery: [...recentRecoveryStates, recovery],
    efficiencyTrend: efficiency,
    weeklyDistanceMeters,
    daysSinceLastRun,
    activePainReported: checkIn?.hasPain ?? false,
    consecutiveLowEnergyDays,
  });

  // --- Plan ----------------------------------------------------------------
  const plan = await loadPlan(db, athleteId, today);

  // --- Next race -----------------------------------------------------------
  const [nextRace] = await db
    .select()
    .from(raceGoals)
    .where(
      and(
        eq(raceGoals.athleteId, athleteId),
        eq(raceGoals.status, 'upcoming'),
        gte(raceGoals.date, today),
      ),
    )
    .orderBy(raceGoals.date)
    .limit(1);

  return {
    profile,
    timezone,
    today,
    workouts,
    recentRuns,
    recoveryRecords,
    sleepRecords,
    checkIn,
    recentCheckIns,
    recovery,
    recentRecoveryStates,
    loadState,
    trainingState,
    fitness,
    efficiency,
    zones,
    maxHeartRateBpm,
    restingHeartRateBpm,
    weightKilograms: latest('weight_kg'),
    plan,
    nextRace,
    weeklyDistanceMeters,
    daysSinceLastRun,
    recentHardSessionDates,
  };
}

function computeLoadState(
  workouts: readonly CanonicalWorkout[],
  today: string,
  timezone: string,
): TrainingLoadState | undefined {
  const loads = workouts
    .filter((w) => w.trainingLoad !== undefined)
    .map((w) => ({
      workoutId: w.id,
      date: toLocalDate(w.startTime, w.timezone || timezone),
      load: w.trainingLoad!,
      model: 'trimp_hr' as const,
      confidence: 1,
      basis: '',
    }));

  if (loads.length === 0) return undefined;

  const from = loads[0]!.date;
  const daily = toDailySeriesLocal(loads, from, today);
  return computeTrainingLoadState(daily);
}

function toDailySeriesLocal(
  loads: readonly { date: string; load: number }[],
  from: string,
  to: string,
): { date: string; load: number }[] {
  const byDate = new Map<string, number>();
  for (const load of loads) byDate.set(load.date, (byDate.get(load.date) ?? 0) + load.load);

  const out: { date: string; load: number }[] = [];
  const span = daysBetweenLocalDates(from, to);
  for (let i = 0; i <= span; i++) {
    const date = addDaysToLocalDate(from, i);
    out.push({ date, load: byDate.get(date) ?? 0 });
  }
  return out;
}

/** Trailing weekly distance totals, oldest first. */
export function computeWeeklyDistances(
  runs: readonly CanonicalWorkout[],
  timezone: string,
  today: string,
  weeks: number,
): number[] {
  const byWeek = new Map<string, number>();
  for (const run of runs) {
    const week = startOfWeek(toLocalDate(run.startTime, run.timezone || timezone));
    byWeek.set(week, (byWeek.get(week) ?? 0) + (run.distanceMeters ?? 0));
  }

  const out: number[] = [];
  const currentWeek = startOfWeek(today);
  for (let i = weeks - 1; i >= 0; i--) {
    out.push(byWeek.get(addDaysToLocalDate(currentWeek, -i * 7)) ?? 0);
  }
  return out;
}

async function loadPlan(
  db: Awaited<ReturnType<typeof getDb>>['db'],
  athleteId: string,
  today: string,
): Promise<AthleteContext['plan']> {
  const [plan] = await db
    .select()
    .from(trainingPlans)
    .where(and(eq(trainingPlans.athleteId, athleteId), eq(trainingPlans.status, 'active')))
    .orderBy(desc(trainingPlans.createdAt))
    .limit(1);

  if (!plan) return undefined;

  const blocks = await db
    .select()
    .from(trainingBlocks)
    .where(eq(trainingBlocks.planId, plan.id))
    .orderBy(trainingBlocks.orderIndex);

  const weekStart = startOfWeek(today);
  const weekEnd = addDaysToLocalDate(weekStart, 6);

  const weekWorkouts = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.planId, plan.id),
        gte(plannedWorkouts.date, weekStart),
        lte(plannedWorkouts.date, weekEnd),
      ),
    )
    .orderBy(plannedWorkouts.date);

  const upcoming = await db
    .select()
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.planId, plan.id), gte(plannedWorkouts.date, today)))
    .orderBy(plannedWorkouts.date)
    .limit(14);

  return {
    plan,
    blocks,
    upcoming,
    weekWorkouts,
    todayWorkout: weekWorkouts.find((w) => w.date === today),
  };
}

/** Race prediction for a distance, using the context's fitness estimate. */
export function predictForDistance(context: AthleteContext, distanceMeters: number) {
  const best = context.recentRuns
    .filter((w) => (w.type === 'race' || w.type === 'time_trial') && w.distanceMeters && w.movingTimeSeconds)
    .map((w) => ({
      distanceMeters: w.distanceMeters!,
      durationSeconds: w.movingTimeSeconds!,
      date: toLocalDate(w.startTime, w.timezone),
      source: 'time_trial' as const,
    }))
    .sort((a, b) => b.date.localeCompare(a.date))[0];

  return predictRace(distanceMeters, context.fitness, best, context.today);
}

/** Intensity distribution over the trailing week. */
export function weeklyIntensityDistribution(context: AthleteContext) {
  const weekStart = startOfWeek(context.today);
  const thisWeek = context.recentRuns.filter(
    (w) => toLocalDate(w.startTime, w.timezone) >= weekStart,
  );
  return computeIntensityDistribution(thisWeek, context.zones);
}

/** Weekly summary for the current week. */
export function currentWeekSummary(context: AthleteContext) {
  const weekStart = startOfWeek(context.today);
  const completed = context.recentRuns.filter(
    (w) => toLocalDate(w.startTime, w.timezone) >= weekStart,
  );
  const planned = context.plan?.weekWorkouts ?? [];

  return buildWeeklySummary({
    weekStart,
    completed,
    planned: planned.map((p) => ({
      id: p.id,
      planId: p.planId,
      blockId: p.blockId,
      date: p.date,
      type: p.type as CanonicalWorkout['type'],
      title: p.title,
      purpose: p.purpose,
      targetDistanceMeters: p.targetDistanceMeters ?? undefined,
      targetDurationSeconds: p.targetDurationSeconds ?? undefined,
      status: p.status as 'planned',
    })),
    loads: completed
      .filter((w) => w.trainingLoad !== undefined)
      .map((w) => ({
        workoutId: w.id,
        date: toLocalDate(w.startTime, w.timezone),
        load: w.trainingLoad!,
        model: 'trimp_hr' as const,
        confidence: 1,
        basis: '',
      })),
    intensityDistribution: weeklyIntensityDistribution(context),
  });
}
