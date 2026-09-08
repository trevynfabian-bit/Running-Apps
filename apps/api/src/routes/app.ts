/**
 * Authenticated application routes: profile, dashboard, plan, workouts,
 * progress, recovery, race goals, reviews and the coach.
 */

import { Hono } from 'hono';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import {
  checkInSchema,
  createManualWorkoutSchema,
  createRaceGoalSchema,
  generatePlanSchema,
  coachMessageSchema,
  updateAthleteProfileSchema,
} from '@running/contracts';
import {
  addDaysToLocalDate,
  analyzeRaceGoal,
  buildWeeklyReview,
  computeRaceReadiness,
  computeTrend,
  daysBetweenLocalDates,
  formatDuration,
  generateTrainingPlan,
  isoWeekKey,
  startOfWeek,
  toLocalDate,
  weeksUntil,
  computeDecoupling,
  decouplingFromSplits,
  efficiencyFactor,
  STANDARD_RACE_DISTANCES,
  type TrendPoint,
} from '@running/core';

import { getDb } from '../db/client.js';
import {
  canonicalWorkouts,
  checkIns,
  coachConversations,
  coachDecisions,
  plannedWorkouts,
  raceGoals,
  raceResults,
  recoveryStates,
  trainingBlocks,
  trainingLoads,
  trainingPlans,
  workoutSources,
  athleteProfiles,
  whoopSleep,
  whoopRecoveries,
  bodyMeasurements,
} from '../db/schema.js';
import type { AuthVariables } from '../security/auth.js';
import { badRequest, notFound } from '../errors.js';
import {
  computeWeeklyDistances,
  currentWeekSummary,
  loadAthleteContext,
  predictForDistance,
  weeklyIntensityDistribution,
} from '../services/athlete-context.js';
import { answerCoachQuestion, computeTodayDecision } from '../services/coach.js';
import { rowToCanonicalWorkout, recomputeTrainingLoads } from '../sync/engine.js';

// Authentication is applied centrally in app.ts; see the PUBLIC_PATHS note there.
export const appRoutes = new Hono<{ Variables: AuthVariables }>();

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

appRoutes.get('/me', async (c) => {
  const { db } = await getDb();
  const [profile] = await db
    .select()
    .from(athleteProfiles)
    .where(eq(athleteProfiles.id, c.get('athleteId')))
    .limit(1);

  if (!profile) throw notFound('Athlete');

  return c.json({
    id: profile.id,
    displayName: profile.displayName,
    dateOfBirth: profile.dateOfBirth ?? undefined,
    sex: profile.sex,
    background: profile.background,
    availability: profile.availability,
    constraints: profile.constraints,
    preferences: {
      units: profile.units,
      primaryZoneMethodology: profile.zoneMethodology,
      timezone: profile.timezone,
      notifications: profile.notifications,
    },
    markers: {
      maxHeartRateBpm: profile.maxHeartRateBpm ?? undefined,
      restingHeartRateBpm: profile.restingHeartRateBpm ?? undefined,
      thresholdHeartRateBpm: profile.thresholdHeartRateBpm ?? undefined,
      thresholdPaceSecondsPerKm: profile.thresholdPaceSecondsPerKm ?? undefined,
    },
    hasCompletedOnboarding: profile.hasCompletedOnboarding,
  });
});

appRoutes.patch('/me', async (c) => {
  const parsed = updateAthleteProfileSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw badRequest('Some of those values were not valid.', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }

  const { db } = await getDb();
  const patch = parsed.data;

  await db
    .update(athleteProfiles)
    .set({
      ...(patch.displayName ? { displayName: patch.displayName } : {}),
      ...(patch.dateOfBirth ? { dateOfBirth: patch.dateOfBirth } : {}),
      ...(patch.sex ? { sex: patch.sex } : {}),
      ...(patch.background ? { background: patch.background } : {}),
      ...(patch.availability ? { availability: patch.availability } : {}),
      ...(patch.constraints ? { constraints: patch.constraints } : {}),
      ...(patch.preferences?.timezone ? { timezone: patch.preferences.timezone } : {}),
      ...(patch.preferences?.units ? { units: patch.preferences.units } : {}),
      ...(patch.preferences?.primaryZoneMethodology
        ? { zoneMethodology: patch.preferences.primaryZoneMethodology }
        : {}),
      ...(patch.preferences?.notifications ? { notifications: patch.preferences.notifications } : {}),
      ...(patch.markers?.maxHeartRateBpm !== undefined
        ? { maxHeartRateBpm: patch.markers.maxHeartRateBpm }
        : {}),
      ...(patch.markers?.restingHeartRateBpm !== undefined
        ? { restingHeartRateBpm: patch.markers.restingHeartRateBpm }
        : {}),
      ...(patch.markers?.thresholdHeartRateBpm !== undefined
        ? { thresholdHeartRateBpm: patch.markers.thresholdHeartRateBpm }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(athleteProfiles.id, c.get('athleteId')));

  return c.json({ ok: true });
});

appRoutes.post('/me/complete-onboarding', async (c) => {
  const { db } = await getDb();
  await db
    .update(athleteProfiles)
    .set({ hasCompletedOnboarding: true, updatedAt: new Date() })
    .where(eq(athleteProfiles.id, c.get('athleteId')));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

appRoutes.get('/dashboard', async (c) => {
  const athleteId = c.get('athleteId');
  const context = await loadAthleteContext(athleteId);
  const { db } = await getDb();

  const decision = computeTodayDecision(context);

  // Persist today's recovery state and decision so trends and reviews have a
  // durable record, and repeated dashboard loads stay consistent.
  await db
    .insert(recoveryStates)
    .values({
      athleteId,
      date: context.today,
      score: context.recovery.score,
      band: context.recovery.band,
      components: context.recovery.components,
      missingSignals: context.recovery.missingSignals,
      dataCompleteness: context.recovery.dataCompleteness,
      summary: context.recovery.summary,
    })
    .onConflictDoUpdate({
      target: [recoveryStates.athleteId, recoveryStates.date],
      set: {
        score: context.recovery.score,
        band: context.recovery.band,
        components: context.recovery.components,
        missingSignals: context.recovery.missingSignals,
        dataCompleteness: context.recovery.dataCompleteness,
        summary: context.recovery.summary,
        computedAt: new Date(),
      },
    });

  if (decision) {
    await db
      .insert(coachDecisions)
      .values({
        athleteId,
        date: context.today,
        decision: decision.decision,
        confidence: decision.confidence,
        reasons: decision.reasons,
        headline: decision.headline,
        explanation: decision.explanation,
        affectedWorkoutId: decision.affectedWorkoutId ?? null,
        previousPlan: (decision.previousPlan as object) ?? null,
        recommendedPlan: (decision.recommendedPlan as object) ?? null,
      })
      .onConflictDoUpdate({
        target: [coachDecisions.athleteId, coachDecisions.date],
        set: {
          decision: decision.decision,
          confidence: decision.confidence,
          reasons: decision.reasons,
          headline: decision.headline,
          explanation: decision.explanation,
          recommendedPlan: (decision.recommendedPlan as object) ?? null,
        },
      });
  }

  const week = currentWeekSummary(context);
  const block = context.plan?.blocks.find(
    (b) => b.startDate <= context.today && b.endDate >= context.today,
  );

  const raceAnalysis = context.nextRace
    ? analyzeRaceGoal(
        {
          id: context.nextRace.id,
          athleteId,
          name: context.nextRace.name,
          date: context.nextRace.date,
          distanceMeters: context.nextRace.distanceMeters,
          targetDurationSeconds: context.nextRace.targetDurationSeconds ?? undefined,
          priority: context.nextRace.priority as 'A',
          status: 'upcoming',
          createdAt: context.nextRace.createdAt,
        },
        predictForDistance(context, context.nextRace.distanceMeters),
        context.today,
      )
    : undefined;

  // The workout shown is the adjusted one when the engine modified it.
  const todayWorkout = decision?.recommendedPlan ?? toPlannedDto(context.plan?.todayWorkout);

  return c.json({
    date: context.today,
    greeting: greetingFor(context.today, context.timezone, context.profile.displayName),
    readiness: {
      score: context.recovery.score,
      band: context.recovery.band,
      summary: context.recovery.summary,
      dataCompleteness: context.recovery.dataCompleteness,
    },
    todayWorkout,
    decision: decision
      ? {
          id: decision.id,
          date: decision.date,
          decision: decision.decision,
          confidence: decision.confidence,
          reasons: decision.reasons,
          headline: decision.headline,
          explanation: decision.explanation,
          affectedWorkoutId: decision.affectedWorkoutId,
          previousPlan: toPlannedDto(context.plan?.todayWorkout),
          recommendedPlan: decision.recommendedPlan,
        }
      : undefined,
    trainingState: {
      state: context.trainingState.state,
      summary: context.trainingState.summary,
      confidence: context.trainingState.confidence,
      recommendProfessionalReview: context.trainingState.recommendProfessionalReview,
    },
    weeklyProgress: {
      completedDistanceMeters: week.completedDistanceMeters,
      targetDistanceMeters: week.plannedDistanceMeters,
      completedSessions: week.completedSessions,
      plannedSessions: week.plannedSessions,
    },
    currentBlock: block
      ? {
          name: block.name,
          goal: block.goal,
          weekInBlock: Math.floor(daysBetweenLocalDates(block.startDate, context.today) / 7) + 1,
          weeksInBlock: block.durationWeeks,
        }
      : undefined,
    raceGoal:
      context.nextRace && raceAnalysis
        ? {
            id: context.nextRace.id,
            name: context.nextRace.name,
            date: context.nextRace.date,
            distanceMeters: context.nextRace.distanceMeters,
            targetDurationSeconds: context.nextRace.targetDurationSeconds ?? undefined,
            currentEstimateSeconds: raceAnalysis.currentEstimateSeconds,
            gapSeconds: raceAnalysis.gapSeconds,
            weeksRemaining: raceAnalysis.weeksRemaining,
            confidence: raceAnalysis.confidence,
          }
        : undefined,
    zones: context.zones
      ? {
          methodology: context.zones.methodology,
          kind: context.zones.kind,
          note: context.zones.note,
          zones: context.zones.zones.map((z) => ({
            number: z.number,
            name: z.name,
            purpose: z.purpose,
            lowerBound: z.lowerBound,
            upperBound: Number.isFinite(z.upperBound) ? z.upperBound : 0,
          })),
        }
      : undefined,
    needsCheckIn: context.checkIn === undefined,
  });
});

function greetingFor(_today: string, timezone: string, name: string): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }).format(
      new Date(),
    ),
  );
  const first = name.split(' ')[0] ?? name;
  if (hour < 12) return `Good morning, ${first}`;
  if (hour < 18) return `Good afternoon, ${first}`;
  return `Good evening, ${first}`;
}

function toPlannedDto(row: typeof plannedWorkouts.$inferSelect | undefined) {
  if (!row) return undefined;
  return {
    id: row.id,
    date: row.date,
    type: row.type,
    title: row.title,
    purpose: row.purpose,
    targetDistanceMeters: row.targetDistanceMeters ?? undefined,
    targetDurationSeconds: row.targetDurationSeconds ?? undefined,
    targetRpe: row.targetRpe ?? undefined,
    structure: row.structure ?? undefined,
    status: row.status,
    modifiedFrom: row.modifiedFrom ?? undefined,
    completedWorkoutId: row.completedWorkoutId ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Check-in and recovery
// ---------------------------------------------------------------------------

appRoutes.post('/check-in', async (c) => {
  const parsed = checkInSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw badRequest('Check-in values must be between 1 and 5.');

  const athleteId = c.get('athleteId');
  const { db } = await getDb();

  const [profile] = await db
    .select()
    .from(athleteProfiles)
    .where(eq(athleteProfiles.id, athleteId))
    .limit(1);

  const date = parsed.data.date ?? toLocalDate(new Date(), profile?.timezone ?? 'UTC');

  await db
    .insert(checkIns)
    .values({
      athleteId,
      date,
      energy: parsed.data.energy,
      soreness: parsed.data.soreness,
      stress: parsed.data.stress,
      motivation: parsed.data.motivation,
      hasPain: parsed.data.hasPain,
      painNote: parsed.data.painNote ?? null,
    })
    // Re-submitting the same day replaces the earlier answer.
    .onConflictDoUpdate({
      target: [checkIns.athleteId, checkIns.date],
      set: {
        energy: parsed.data.energy,
        soreness: parsed.data.soreness,
        stress: parsed.data.stress,
        motivation: parsed.data.motivation,
        hasPain: parsed.data.hasPain,
        painNote: parsed.data.painNote ?? null,
      },
    });

  // The check-in changes readiness, which can change today's session.
  const context = await loadAthleteContext(athleteId, { today: date });
  const decision = computeTodayDecision(context);

  return c.json({
    ok: true,
    readiness: {
      score: context.recovery.score,
      band: context.recovery.band,
      summary: context.recovery.summary,
      dataCompleteness: context.recovery.dataCompleteness,
    },
    decision: decision
      ? { decision: decision.decision, headline: decision.headline, explanation: decision.explanation }
      : undefined,
  });
});

appRoutes.get('/recovery', async (c) => {
  const context = await loadAthleteContext(c.get('athleteId'));
  return c.json({
    today: {
      date: context.recovery.date,
      score: context.recovery.score,
      band: context.recovery.band,
      components: context.recovery.components,
      missingSignals: context.recovery.missingSignals,
      dataCompleteness: context.recovery.dataCompleteness,
      summary: context.recovery.summary,
    },
    history: context.recentRecoveryStates.map((r) => ({
      date: r.date,
      score: r.score,
      band: r.band,
    })),
    sleep: context.sleepRecords.slice(-30).map((s) => ({
      date: s.date,
      hours: Number((s.totalSleepSeconds / 3600).toFixed(2)),
      performancePercent: s.performancePercent,
    })),
  });
});

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

appRoutes.get('/training-plan', async (c) => {
  const context = await loadAthleteContext(c.get('athleteId'));
  if (!context.plan) return c.json({ plan: undefined, weeks: [] });

  const { db } = await getDb();
  const all = await db
    .select()
    .from(plannedWorkouts)
    .where(eq(plannedWorkouts.planId, context.plan.plan.id))
    .orderBy(plannedWorkouts.date);

  // Group into weeks for the Plan screen.
  const byWeek = new Map<string, typeof all>();
  for (const workout of all) {
    const week = startOfWeek(workout.date);
    const list = byWeek.get(week) ?? [];
    list.push(workout);
    byWeek.set(week, list);
  }

  const completedByDate = new Map<string, number>();
  for (const run of context.recentRuns) {
    const date = toLocalDate(run.startTime, run.timezone);
    completedByDate.set(date, (completedByDate.get(date) ?? 0) + (run.distanceMeters ?? 0));
  }

  const weeks = [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, workouts]) => {
      const block = context.plan!.blocks.find(
        (b) => b.startDate <= weekStart && b.endDate >= weekStart,
      );
      const weekInBlock = block
        ? Math.floor(daysBetweenLocalDates(block.startDate, weekStart) / 7) + 1
        : 1;

      return {
        weekStart,
        weekKey: isoWeekKey(weekStart),
        blockName: block?.name ?? '—',
        blockType: block?.type ?? 'base',
        weekInBlock,
        weeksInBlock: block?.durationWeeks ?? 1,
        targetDistanceMeters:
          (block?.weeklyDistanceTargetsMeters as number[] | undefined)?.[weekInBlock - 1] ??
          workouts.reduce((acc, w) => acc + (w.targetDistanceMeters ?? 0), 0),
        completedDistanceMeters: workouts.reduce(
          (acc, w) => acc + (completedByDate.get(w.date) ?? 0),
          0,
        ),
        workouts: workouts.map((w) => toPlannedDto(w)!),
      };
    });

  return c.json({
    plan: {
      id: context.plan.plan.id,
      name: context.plan.plan.name,
      template: context.plan.plan.template,
      status: context.plan.plan.status,
      startDate: context.plan.plan.startDate,
      endDate: context.plan.plan.endDate,
      raceGoalId: context.plan.plan.raceGoalId ?? undefined,
      blocks: context.plan.blocks.map((b) => ({
        id: b.id,
        type: b.type,
        name: b.name,
        goal: b.goal,
        startDate: b.startDate,
        endDate: b.endDate,
        durationWeeks: b.durationWeeks,
        orderIndex: b.orderIndex,
        weeklyDistanceTargetsMeters: b.weeklyDistanceTargetsMeters,
      })),
      generationBasis: context.plan.plan.generationBasis,
    },
    weeks,
  });
});

appRoutes.post('/training-plan/generate', async (c) => {
  const parsed = generatePlanSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw badRequest('Choose a valid training program.');

  const athleteId = c.get('athleteId');
  const context = await loadAthleteContext(athleteId);
  const { db } = await getDb();

  // A race goal, if given, sets the plan length.
  let raceDate: string | undefined;
  let raceDistanceMeters: number | undefined;
  if (parsed.data.raceGoalId) {
    const [race] = await db
      .select()
      .from(raceGoals)
      .where(and(eq(raceGoals.id, parsed.data.raceGoalId), eq(raceGoals.athleteId, athleteId)))
      .limit(1);
    if (!race) throw notFound('Race goal');
    raceDate = race.date;
    raceDistanceMeters = race.distanceMeters;
  }

  const startDate = parsed.data.startDate ?? context.today;
  const totalWeeks =
    parsed.data.totalWeeks ?? (raceDate ? weeksUntil(startDate, raceDate) : 12);

  if (totalWeeks < 1) throw badRequest('That race date is in the past.');

  const recentWeekly = computeWeeklyDistances(context.recentRuns, context.timezone, context.today, 4);
  const currentWeeklyDistanceMeters =
    recentWeekly.filter((v) => v > 0).reduce((a, b, _i, arr) => a + b / arr.length, 0) || 0;

  const availability = context.profile.availability as never;
  const constraints = context.profile.constraints as never;

  const plan = generateTrainingPlan({
    athleteId,
    template: parsed.data.template,
    startDate,
    totalWeeks,
    availability,
    constraints,
    fitness: context.fitness,
    currentWeeklyDistanceMeters,
    longestRecentRunMeters: Math.max(
      0,
      ...context.recentRuns.map((w) => w.distanceMeters ?? 0),
    ),
    raceGoalId: parsed.data.raceGoalId,
    raceDate,
    raceDistanceMeters,
    idFactory: () => randomUUID(),
  });

  // Supersede any previous active plan rather than leaving two live.
  await db
    .update(trainingPlans)
    .set({ status: 'abandoned', updatedAt: new Date() })
    .where(and(eq(trainingPlans.athleteId, athleteId), eq(trainingPlans.status, 'active')));

  await db.insert(trainingPlans).values({
    id: plan.id,
    athleteId,
    name: plan.name,
    template: plan.template,
    status: 'active',
    startDate: plan.startDate,
    endDate: plan.endDate,
    raceGoalId: plan.raceGoalId ?? null,
    generationBasis: plan.generationBasis,
  });

  for (const block of plan.blocks) {
    await db.insert(trainingBlocks).values({
      id: block.id,
      planId: plan.id,
      type: block.type,
      name: block.name,
      goal: block.goal,
      startDate: block.startDate,
      endDate: block.endDate,
      durationWeeks: block.durationWeeks,
      orderIndex: block.orderIndex,
      weeklyDistanceTargetsMeters: block.weeklyDistanceTargetsMeters,
    });
  }

  for (const workout of plan.workouts) {
    await db.insert(plannedWorkouts).values({
      id: workout.id,
      planId: plan.id,
      blockId: workout.blockId,
      athleteId,
      date: workout.date,
      type: workout.type,
      title: workout.title,
      purpose: workout.purpose,
      targetDistanceMeters: workout.targetDistanceMeters ?? null,
      targetDurationSeconds: workout.targetDurationSeconds ?? null,
      targetRpe: workout.targetRpe ?? null,
      structure: (workout.structure as object) ?? null,
      status: 'planned',
    });
  }

  return c.json({
    id: plan.id,
    name: plan.name,
    startDate: plan.startDate,
    endDate: plan.endDate,
    blocks: plan.blocks.length,
    workouts: plan.workouts.length,
    generationBasis: plan.generationBasis,
  });
});

// ---------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------

appRoutes.get('/workouts', async (c) => {
  const athleteId = c.get('athleteId');
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
  const { db } = await getDb();

  const rows = await db
    .select()
    .from(canonicalWorkouts)
    .where(eq(canonicalWorkouts.athleteId, athleteId))
    .orderBy(desc(canonicalWorkouts.startTime))
    .limit(limit);

  const sources = await db.select().from(workoutSources);
  const sourcesByWorkout = new Map<string, typeof sources>();
  for (const source of sources) {
    const list = sourcesByWorkout.get(source.canonicalWorkoutId) ?? [];
    list.push(source);
    sourcesByWorkout.set(source.canonicalWorkoutId, list);
  }

  return c.json({
    workouts: rows.map((row) => ({
      ...toWorkoutSummary(row),
      sourceRecords: (sourcesByWorkout.get(row.id) ?? []).map((s) => ({
        provider: s.provider,
        externalId: s.externalId,
        contributedFields: s.contributedFields,
      })),
    })),
  });
});

function toWorkoutSummary(row: typeof canonicalWorkouts.$inferSelect) {
  return {
    id: row.id,
    type: row.type,
    sport: row.sport,
    name: row.name ?? undefined,
    startTime: row.startTime.toISOString(),
    endTime: row.endTime.toISOString(),
    timezone: row.timezone,
    localDate: row.localDate,
    durationSeconds: row.durationSeconds ?? undefined,
    movingTimeSeconds: row.movingTimeSeconds ?? undefined,
    distanceMeters: row.distanceMeters ?? undefined,
    avgPaceSecondsPerKm: row.avgPaceSecondsPerKm ?? undefined,
    avgHeartRateBpm: row.avgHeartRateBpm ?? undefined,
    maxHeartRateBpm: row.maxHeartRateBpm ?? undefined,
    elevationGainMeters: row.elevationGainMeters ?? undefined,
    avgCadenceSpm: row.avgCadenceSpm ?? undefined,
    calories: row.calories ?? undefined,
    trainingLoad: row.trainingLoad ?? undefined,
    perceivedExertion: row.perceivedExertion ?? undefined,
    indoor: row.indoor ?? undefined,
    sourceConfidence: row.sourceConfidence,
    plannedWorkoutId: row.plannedWorkoutId ?? undefined,
    sourceRecords: [],
  };
}

appRoutes.get('/workouts/:id', async (c) => {
  const athleteId = c.get('athleteId');
  const { db } = await getDb();

  const [row] = await db
    .select()
    .from(canonicalWorkouts)
    .where(
      and(eq(canonicalWorkouts.id, c.req.param('id')), eq(canonicalWorkouts.athleteId, athleteId)),
    )
    .limit(1);

  if (!row) throw notFound('Workout');

  const sources = await db
    .select()
    .from(workoutSources)
    .where(eq(workoutSources.canonicalWorkoutId, row.id));

  const workout = rowToCanonicalWorkout(row);

  // --- Post-workout analysis ----------------------------------------------
  const planned = row.plannedWorkoutId
    ? (
        await db
          .select()
          .from(plannedWorkouts)
          .where(eq(plannedWorkouts.id, row.plannedWorkoutId))
          .limit(1)
      )[0]
    : undefined;

  const decoupling = workout.samples?.length
    ? computeDecoupling(workout.samples)
    : workout.splits?.length
      ? decouplingFromSplits(workout.splits)
      : undefined;

  const ef =
    workout.distanceMeters && workout.movingTimeSeconds && workout.avgHeartRateBpm
      ? efficiencyFactor(workout.distanceMeters, workout.movingTimeSeconds, workout.avgHeartRateBpm)
      : undefined;

  const notes: string[] = [];
  if (planned?.targetDistanceMeters && workout.distanceMeters) {
    const delta = workout.distanceMeters - planned.targetDistanceMeters;
    const percent = (delta / planned.targetDistanceMeters) * 100;
    notes.push(
      Math.abs(percent) < 5
        ? 'Distance matched the prescription closely.'
        : `You ran ${Math.abs(percent).toFixed(0)}% ${delta > 0 ? 'further' : 'shorter'} than prescribed.`,
    );
  }

  return c.json({
    ...toWorkoutSummary(row),
    sourceRecords: sources.map((s) => ({
      provider: s.provider,
      externalId: s.externalId,
      contributedFields: s.contributedFields,
    })),
    splits: row.splits ?? undefined,
    route: row.route ?? undefined,
    analysis: {
      workoutId: row.id,
      execution: {
        plannedDistanceMeters: planned?.targetDistanceMeters ?? undefined,
        actualDistanceMeters: workout.distanceMeters,
        plannedDurationSeconds: planned?.targetDurationSeconds ?? undefined,
        actualDurationSeconds: workout.movingTimeSeconds ?? workout.durationSeconds,
        adherence:
          planned?.targetDistanceMeters && workout.distanceMeters
            ? Math.min(1, workout.distanceMeters / planned.targetDistanceMeters)
            : undefined,
        notes,
      },
      efficiency: ef !== undefined ? { efficiencyFactor: Number(ef.toFixed(3)) } : undefined,
      decoupling: decoupling
        ? {
            driftPercent: decoupling.driftPercent,
            isValid: decoupling.isValid,
            invalidReason: decoupling.invalidReason,
            interpretation: decoupling.interpretation,
          }
        : undefined,
      trainingEffect: {
        trainingLoad: row.trainingLoad ?? undefined,
        loadModel: row.loadModel ?? undefined,
      },
      insight: buildWorkoutInsight(workout, decoupling?.interpretation, notes),
    },
  });
});

function buildWorkoutInsight(
  workout: ReturnType<typeof rowToCanonicalWorkout>,
  drift: string | undefined,
  notes: readonly string[],
): string {
  const parts: string[] = [];
  if (workout.distanceMeters && workout.movingTimeSeconds) {
    parts.push(
      `You covered ${(workout.distanceMeters / 1000).toFixed(2)} km in ${formatDuration(workout.movingTimeSeconds)}.`,
    );
  }
  if (workout.avgHeartRateBpm) {
    parts.push(`Average heart rate was ${Math.round(workout.avgHeartRateBpm)} bpm.`);
  }
  parts.push(...notes);
  if (drift) parts.push(drift);
  return parts.join(' ');
}

appRoutes.post('/workouts', async (c) => {
  const parsed = createManualWorkoutSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw badRequest('Check the workout details.');

  const athleteId = c.get('athleteId');
  const { db } = await getDb();

  const [profile] = await db
    .select()
    .from(athleteProfiles)
    .where(eq(athleteProfiles.id, athleteId))
    .limit(1);
  const timezone = profile?.timezone ?? 'UTC';

  const startTime = new Date(parsed.data.startTime);
  const id = randomUUID();

  await db.insert(canonicalWorkouts).values({
    id,
    athleteId,
    type: parsed.data.type,
    sport: parsed.data.sport,
    startTime,
    endTime: new Date(startTime.getTime() + parsed.data.durationSeconds * 1000),
    timezone,
    localDate: toLocalDate(startTime, timezone),
    durationSeconds: parsed.data.durationSeconds,
    movingTimeSeconds: parsed.data.durationSeconds,
    distanceMeters: parsed.data.distanceMeters ?? null,
    avgHeartRateBpm: parsed.data.avgHeartRateBpm ?? null,
    avgPaceSecondsPerKm:
      parsed.data.distanceMeters && parsed.data.distanceMeters > 0
        ? (parsed.data.durationSeconds / parsed.data.distanceMeters) * 1000
        : null,
    perceivedExertion: parsed.data.perceivedExertion ?? null,
    // A manually entered workout is a direct report from the athlete.
    sourceConfidence: 0.85,
  });

  await db.insert(workoutSources).values({
    canonicalWorkoutId: id,
    provider: 'manual',
    externalId: id,
    contributedFields: ['all'],
  });

  await recomputeTrainingLoads(db, athleteId);

  return c.json({ id }, 201);
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

appRoutes.get('/progress', async (c) => {
  const athleteId = c.get('athleteId');
  const windowDays = Math.min(Number(c.req.query('windowDays') ?? 84), 365);
  const context = await loadAthleteContext(athleteId);
  const { db } = await getDb();

  const from = addDaysToLocalDate(context.today, -windowDays);

  // --- Training series -----------------------------------------------------
  const weeklyDistance: TrendPoint[] = [];
  const longestRun: TrendPoint[] = [];
  const byWeek = new Map<string, { distance: number; longest: number }>();

  for (const run of context.recentRuns) {
    const date = toLocalDate(run.startTime, run.timezone);
    if (date < from) continue;
    const week = startOfWeek(date);
    const entry = byWeek.get(week) ?? { distance: 0, longest: 0 };
    entry.distance += run.distanceMeters ?? 0;
    entry.longest = Math.max(entry.longest, run.distanceMeters ?? 0);
    byWeek.set(week, entry);
  }

  for (const [week, entry] of [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    weeklyDistance.push({ date: week, value: Number((entry.distance / 1000).toFixed(2)) });
    longestRun.push({ date: week, value: Number((entry.longest / 1000).toFixed(2)) });
  }

  const loadRows = await db
    .select()
    .from(trainingLoads)
    .where(and(eq(trainingLoads.athleteId, athleteId), gte(trainingLoads.date, from)))
    .orderBy(trainingLoads.date);

  const weeklyLoad: TrendPoint[] = loadRows
    .filter((r) => r.weeklyLoad !== null)
    .map((r) => ({ date: r.date, value: Number((r.weeklyLoad ?? 0).toFixed(1)) }));

  // --- Recovery series -----------------------------------------------------
  const recoveryRows = await db
    .select()
    .from(recoveryStates)
    .where(and(eq(recoveryStates.athleteId, athleteId), gte(recoveryStates.date, from)))
    .orderBy(recoveryStates.date);

  const physiologyRows = await db
    .select()
    .from(whoopRecoveries)
    .where(and(eq(whoopRecoveries.athleteId, athleteId), gte(whoopRecoveries.localDate, from)))
    .orderBy(whoopRecoveries.localDate);

  const sleepRows = await db
    .select()
    .from(whoopSleep)
    .where(and(eq(whoopSleep.athleteId, athleteId), gte(whoopSleep.localDate, from)))
    .orderBy(whoopSleep.localDate);

  const hrv: TrendPoint[] = physiologyRows
    .filter((r) => r.hrvRmssdMilli !== null)
    .map((r) => ({ date: r.localDate, value: Number(r.hrvRmssdMilli!.toFixed(1)) }));

  const restingHr: TrendPoint[] = physiologyRows
    .filter((r) => r.restingHeartRate !== null)
    .map((r) => ({ date: r.localDate, value: Number(r.restingHeartRate!.toFixed(1)) }));

  const sleepHours: TrendPoint[] = sleepRows
    .filter((r) => !r.nap)
    .map((r) => ({
      date: r.localDate,
      value: Number(
        (
          ((r.totalLightSleepTimeMilli ?? 0) +
            (r.totalSlowWaveSleepTimeMilli ?? 0) +
            (r.totalRemSleepTimeMilli ?? 0)) /
          3_600_000
        ).toFixed(2),
      ),
    }));

  // --- Body ----------------------------------------------------------------
  const weightRows = await db
    .select()
    .from(bodyMeasurements)
    .where(and(eq(bodyMeasurements.athleteId, athleteId), eq(bodyMeasurements.metric, 'weight_kg')))
    .orderBy(bodyMeasurements.measuredAt);

  const weight: TrendPoint[] = weightRows
    .filter((r) => r.measuredAt.toISOString().slice(0, 10) >= from)
    .map((r) => ({
      date: r.measuredAt.toISOString().slice(0, 10),
      value: Number(r.normalizedValue.toFixed(1)),
    }));

  // --- Race predictions ----------------------------------------------------
  const predictions = (
    ['5k', '10k', 'half_marathon', 'marathon'] as const
  ).flatMap((key) => {
    const distance = STANDARD_RACE_DISTANCES[key];
    const prediction = predictForDistance(context, distance);
    if (!prediction) return [];
    return [
      {
        distanceMeters: distance,
        label: key === 'half_marathon' ? 'Half marathon' : key === 'marathon' ? 'Marathon' : key.toUpperCase(),
        predictedDurationSeconds: Math.round(prediction.predictedDurationSeconds),
        predictedPaceSecondsPerKm: Math.round(prediction.predictedPaceSecondsPerKm),
        confidence: prediction.confidence,
        method: prediction.method,
        basis: prediction.basis,
      },
    ];
  });

  return c.json({
    windowDays,
    fitness: {
      estimatedVo2Max: context.fitness.estimatedVo2Max,
      thresholdPaceSecondsPerKm: context.fitness.thresholdPaceSecondsPerKm,
      easyPaceRangeSecondsPerKm: context.fitness.easyPaceRangeSecondsPerKm,
      confidence: context.fitness.confidence,
      basis: context.fitness.basis,
      aerobicEfficiency: context.efficiency
        ? {
            metric: 'Aerobic efficiency',
            direction: context.efficiency.direction,
            percentChange: context.efficiency.changePercent,
            confidence: context.efficiency.confidence,
            sampleCount: context.efficiency.sampleCount,
            windowDays: context.efficiency.windowDays,
            summary: context.efficiency.interpretation,
          }
        : undefined,
    },
    training: {
      weeklyDistance,
      weeklyLoad,
      longestRun,
      distanceTrend:
        weeklyDistance.length >= 4
          ? computeTrend(weeklyDistance, {
              metric: 'Weekly distance',
              polarity: 'higher_is_better',
              unitLabel: 'km',
            })
          : undefined,
    },
    recovery: {
      recoveryScore: recoveryRows.map((r) => ({ date: r.date, value: Math.round(r.score) })),
      hrv,
      restingHeartRate: restingHr,
      sleepHours,
      hrvTrend:
        hrv.length >= 5
          ? computeTrend(hrv, {
              metric: 'HRV',
              polarity: 'higher_is_better',
              unitLabel: 'ms',
              // HRV is noisy day to day; a wider stable band avoids
              // reporting normal variation as a trend.
              stableThresholdPercent: 6,
            })
          : undefined,
      restingHrTrend:
        restingHr.length >= 5
          ? computeTrend(restingHr, {
              metric: 'Resting heart rate',
              polarity: 'lower_is_better',
              unitLabel: 'bpm',
              stableThresholdPercent: 4,
            })
          : undefined,
    },
    body: {
      weightKilograms: weight,
      weightTrend:
        weight.length >= 4
          ? computeTrend(weight, {
              metric: 'Weight',
              polarity: 'lower_is_better',
              unitLabel: 'kg',
              stableThresholdPercent: 2,
            })
          : undefined,
    },
    racePredictions: predictions,
  });
});

// ---------------------------------------------------------------------------
// Race goals
// ---------------------------------------------------------------------------

appRoutes.get('/race-goals', async (c) => {
  const athleteId = c.get('athleteId');
  const context = await loadAthleteContext(athleteId);
  const { db } = await getDb();

  const rows = await db
    .select()
    .from(raceGoals)
    .where(eq(raceGoals.athleteId, athleteId))
    .orderBy(raceGoals.date);

  const goals = rows.map((row) => {
    const analysis = analyzeRaceGoal(
      {
        id: row.id,
        athleteId,
        name: row.name,
        date: row.date,
        distanceMeters: row.distanceMeters,
        targetDurationSeconds: row.targetDurationSeconds ?? undefined,
        priority: row.priority as 'A',
        status: row.status as 'upcoming',
        createdAt: row.createdAt,
      },
      predictForDistance(context, row.distanceMeters),
      context.today,
    );

    const readiness = computeRaceReadiness({
      analysis,
      weeklyDistanceMeters: context.weeklyDistanceMeters,
      longestRecentRunMeters: Math.max(0, ...context.recentRuns.map((w) => w.distanceMeters ?? 0)),
      racePaceSessionCount: context.recentHardSessionDates.length,
    });

    return {
      id: row.id,
      name: row.name,
      date: row.date,
      distanceMeters: row.distanceMeters,
      targetDurationSeconds: row.targetDurationSeconds ?? undefined,
      priority: row.priority,
      status: row.status,
      notes: row.notes ?? undefined,
      weeksRemaining: analysis.weeksRemaining,
      targetPaceSecondsPerKm: analysis.targetPaceSecondsPerKm,
      currentEstimateSeconds: analysis.currentEstimateSeconds,
      gapSeconds: analysis.gapSeconds,
      confidence: analysis.confidence,
      targetLooksUnrealistic: analysis.targetLooksUnrealistic,
      note: analysis.note,
      readiness: {
        score: readiness.score,
        summary: readiness.summary,
        factors: readiness.factors,
      },
    };
  });

  return c.json({ goals });
});

appRoutes.post('/race-goals', async (c) => {
  const parsed = createRaceGoalSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw badRequest('Check the race details.');

  const athleteId = c.get('athleteId');
  const { db } = await getDb();

  const [goal] = await db
    .insert(raceGoals)
    .values({
      athleteId,
      name: parsed.data.name,
      date: parsed.data.date,
      distanceMeters: parsed.data.distanceMeters,
      targetDurationSeconds: parsed.data.targetDurationSeconds ?? null,
      priority: parsed.data.priority,
      notes: parsed.data.notes ?? null,
    })
    .returning();

  return c.json({ id: goal!.id }, 201);
});

appRoutes.post('/race-results', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const distanceMeters = Number(body.distanceMeters);
  const durationSeconds = Number(body.durationSeconds);
  const date = String(body.date ?? '');

  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
    throw badRequest('Enter a valid distance.');
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw badRequest('Enter a valid time.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('Enter a valid date.');

  const { db } = await getDb();
  const [result] = await db
    .insert(raceResults)
    .values({
      athleteId: c.get('athleteId'),
      distanceMeters,
      durationSeconds,
      date,
      source: typeof body.source === 'string' ? body.source : 'self_reported',
      name: typeof body.name === 'string' ? body.name : null,
    })
    .returning();

  return c.json({ id: result!.id }, 201);
});

// ---------------------------------------------------------------------------
// Weekly review
// ---------------------------------------------------------------------------

appRoutes.get('/reviews/weekly', async (c) => {
  const athleteId = c.get('athleteId');
  const context = await loadAthleteContext(athleteId);
  const { db } = await getDb();

  const requested = c.req.query('weekStart');
  const weekStart = requested ?? startOfWeek(addDaysToLocalDate(context.today, -7));
  const weekEnd = addDaysToLocalDate(weekStart, 6);

  const completed = context.recentRuns.filter((w) => {
    const date = toLocalDate(w.startTime, w.timezone);
    return date >= weekStart && date <= weekEnd;
  });

  const planned = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.athleteId, athleteId),
        gte(plannedWorkouts.date, weekStart),
        lte(plannedWorkouts.date, weekEnd),
      ),
    );

  const loads = completed
    .filter((w) => w.trainingLoad !== undefined)
    .map((w) => ({
      workoutId: w.id,
      date: toLocalDate(w.startTime, w.timezone),
      load: w.trainingLoad!,
      model: 'trimp_hr' as const,
      confidence: 1,
      basis: '',
    }));

  const summary = {
    weekKey: isoWeekKey(weekStart),
    weekStart,
    plannedDistanceMeters: planned.reduce((a, w) => a + (w.targetDistanceMeters ?? 0), 0),
    completedDistanceMeters: completed.reduce((a, w) => a + (w.distanceMeters ?? 0), 0),
    plannedSessions: planned.filter((w) => w.type !== 'rest').length,
    completedSessions: completed.length,
    longestRunMeters: Math.max(0, ...completed.map((w) => w.distanceMeters ?? 0)),
    qualitySessions: completed.filter((w) =>
      ['tempo', 'threshold', 'intervals', 'hills', 'race'].includes(w.type),
    ).length,
    totalTrainingLoad: loads.reduce((a, l) => a + l.load, 0),
    totalDurationSeconds: completed.reduce(
      (a, w) => a + (w.movingTimeSeconds ?? w.durationSeconds ?? 0),
      0,
    ),
  };

  const previousWeekStart = addDaysToLocalDate(weekStart, -7);
  const previousCompleted = context.recentRuns.filter((w) => {
    const date = toLocalDate(w.startTime, w.timezone);
    return date >= previousWeekStart && date < weekStart;
  });

  const review = buildWeeklyReview({
    summary,
    previousSummary: {
      ...summary,
      weekStart: previousWeekStart,
      weekKey: isoWeekKey(previousWeekStart),
      completedDistanceMeters: previousCompleted.reduce((a, w) => a + (w.distanceMeters ?? 0), 0),
      completedSessions: previousCompleted.length,
    },
    recoveryStates: context.recentRecoveryStates.filter(
      (r) => r.date >= weekStart && r.date <= weekEnd,
    ),
    sleepSecondsByDay: context.sleepRecords
      .filter((s) => s.date >= weekStart && s.date <= weekEnd)
      .map((s) => s.totalSleepSeconds),
    efficiencyTrend: context.efficiency,
    intensityDistribution: weeklyIntensityDistribution(context),
  });

  return c.json(review);
});

// ---------------------------------------------------------------------------
// Coach
// ---------------------------------------------------------------------------

appRoutes.get('/coach/context', async (c) => {
  const context = await loadAthleteContext(c.get('athleteId'));
  const { buildCoachContext } = await import('../services/coach.js');
  return c.json(buildCoachContext(context));
});

appRoutes.post('/coach/message', async (c) => {
  const parsed = coachMessageSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw badRequest('Type a question for your coach.');

  const athleteId = c.get('athleteId');
  const context = await loadAthleteContext(athleteId);
  const decision = computeTodayDecision(context);
  const { db } = await getDb();

  const history = await db
    .select()
    .from(coachConversations)
    .where(eq(coachConversations.athleteId, athleteId))
    .orderBy(desc(coachConversations.createdAt))
    .limit(6);

  const response = await answerCoachQuestion({
    question: parsed.data.message,
    context,
    decision,
    history: history
      .reverse()
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  });

  await db.insert(coachConversations).values([
    { athleteId, role: 'user', content: parsed.data.message },
    { athleteId, role: 'assistant', content: response.answer, structured: response },
  ]);

  return c.json(response);
});

appRoutes.get('/coach/history', async (c) => {
  const { db } = await getDb();
  const rows = await db
    .select()
    .from(coachConversations)
    .where(eq(coachConversations.athleteId, c.get('athleteId')))
    .orderBy(desc(coachConversations.createdAt))
    .limit(50);

  return c.json({
    messages: rows.reverse().map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      structured: r.structured ?? undefined,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});
