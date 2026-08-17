/**
 * Development seed.
 *
 * Creates the athlete described in the product brief and drives the real
 * pipeline — connect providers, sync (mock), dedup, generate a plan — rather
 * than inserting pre-baked rows. That means the seed exercises the same code
 * paths a real user would, so a broken pipeline fails here rather than
 * silently producing a pretty but fake database.
 */

import { and, eq } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import {
  athleteProfiles,
  providerConnections,
  raceGoals,
  raceResults,
  users,
} from '../db/schema.js';
import { hashPassword } from '../security/crypto.js';
import { loadAthleteContext, computeWeeklyDistances } from '../services/athlete-context.js';
import { generateTrainingPlan, weeksUntil, toLocalDate } from '@running/core';
import { trainingPlans, trainingBlocks, plannedWorkouts, checkIns } from '../db/schema.js';
import { randomUUID } from 'node:crypto';
import { logger } from '../observability/logger.js';

export const SEED_EMAIL = 'athlete@example.com';
export const SEED_PASSWORD = 'run-strong-2026';

const TIMEZONE = 'Asia/Jakarta';

export interface SeedResult {
  userId: string;
  athleteId: string;
  planId?: string;
  workoutCount: number;
}

export async function seed(options: { quiet?: boolean } = {}): Promise<SeedResult> {
  const { db } = await getDb();
  const log = (message: string, context?: Record<string, unknown>): void => {
    if (!options.quiet) logger.info(message, context);
  };

  // --- Account -------------------------------------------------------------
  const [existing] = await db.select().from(users).where(eq(users.email, SEED_EMAIL)).limit(1);

  let userId: string;
  let athleteId: string;

  if (existing) {
    userId = existing.id;
    const [athlete] = await db
      .select()
      .from(athleteProfiles)
      .where(eq(athleteProfiles.userId, userId))
      .limit(1);
    athleteId = athlete!.id;
    log('seed.reusing_existing_athlete', { athleteId });
  } else {
    const [user] = await db
      .insert(users)
      .values({
        email: SEED_EMAIL,
        passwordHash: hashPassword(SEED_PASSWORD),
        displayName: 'Alex Rivera',
      })
      .returning();
    userId = user!.id;

    const [athlete] = await db
      .insert(athleteProfiles)
      .values({
        userId,
        displayName: 'Alex Rivera',
        dateOfBirth: '2002-03-14',
        sex: 'male',
        timezone: TIMEZONE,
        units: 'metric',
        zoneMethodology: 'hr_reserve',
        background: {
          experience: 'recreational',
          typicalWeeklyDistanceMeters: 30_000,
          typicalSessionsPerWeek: 4,
          longestRecentRunMeters: 14_000,
          selfReportedEasyPaceSecondsPerKm: 390,
          yearsRunning: 3,
        },
        availability: {
          runDays: [1, 2, 4, 6, 0],
          longRunDay: 0,
          restDays: [3, 5],
          strengthDays: [2],
          crossTrainingDays: [],
          maxSessionsPerWeek: 5,
          typicalWeekdayMinutes: 60,
          typicalLongRunMinutes: 110,
          preferredTimeOfDay: 'early_morning',
        },
        constraints: {
          activePain: false,
          hasTreadmillAccess: true,
          hasTrackAccess: false,
          hasGymAccess: true,
          surfacePreference: 'road',
          unavailableDates: [],
        },
        notifications: {
          dailyWorkout: true,
          morningCheckIn: true,
          weeklyReview: true,
          planAdjustments: true,
          syncFailures: true,
        },
        maxHeartRateBpm: 194,
        restingHeartRateBpm: 48,
        thresholdHeartRateBpm: 172,
        hasCompletedOnboarding: true,
      })
      .returning();
    athleteId = athlete!.id;
    log('seed.athlete_created', { athleteId });

    // A recent 5K, which anchors every fitness estimate and race prediction.
    await db.insert(raceResults).values({
      athleteId,
      distanceMeters: 5000,
      durationSeconds: 1540, // 25:40
      date: toLocalDate(new Date(Date.now() - 45 * 86_400_000), TIMEZONE),
      source: 'race',
      name: 'Local parkrun',
    });

    await db.insert(raceGoals).values({
      athleteId,
      name: 'Jakarta 10K',
      date: toLocalDate(new Date(Date.now() + 84 * 86_400_000), TIMEZONE),
      distanceMeters: 10_000,
      targetDurationSeconds: 3000, // 50:00
      priority: 'A',
      status: 'upcoming',
    });
  }

  // --- Connect providers and sync -----------------------------------------
  for (const provider of ['strava', 'whoop', 'healthkit'] as const) {
    await db
      .insert(providerConnections)
      .values({
        athleteId,
        provider,
        status: 'connected',
        connectedAt: new Date(),
        externalUserId: `mock-user-${provider}`,
        scopes: [],
        // Mock providers ignore the token value, but the sync path requires
        // one to be present, exactly as it would for a real connection.
        accessTokenEncrypted: null,
      })
      .onConflictDoUpdate({
        target: [providerConnections.athleteId, providerConnections.provider],
        set: { status: 'connected', updatedAt: new Date() },
      });
  }

  // Seed uses the mock providers directly so it works with no credentials.
  const { getProvider } = await import('../providers/registry.js');
  const { rebuildCanonicalWorkouts, recomputeTrainingLoads, persistPayload } = await import(
    '../sync/engine.js'
  );

  for (const providerId of ['strava', 'whoop', 'healthkit'] as const) {
    const provider = getProvider(providerId);
    if (!provider) continue;

    const [connection] = await db
      .select()
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.athleteId, athleteId),
          eq(providerConnections.provider, providerId),
        ),
      )
      .limit(1);
    if (!connection) continue;

    const payload = await provider.sync({
      tokens: { accessToken: 'mock', scopes: [] },
      window: {},
      athleteId,
      timezone: TIMEZONE,
    });

    // Same persistence path a real sync uses.
    await persistPayload(db, {
      athleteId,
      connectionId: connection.id,
      provider: providerId,
      payload,
      timezone: TIMEZONE,
    });

    log('seed.provider_synced', { provider: providerId, workouts: payload.workouts.length });
  }

  const since = new Date(Date.now() - 200 * 86_400_000);
  const rebuild = await rebuildCanonicalWorkouts(db, athleteId, TIMEZONE, since);
  await recomputeTrainingLoads(db, athleteId);
  log('seed.deduplicated', {
    canonical: rebuild.canonicalCount,
    merged: rebuild.duplicatesMerged,
  });

  // --- Morning check-ins ---------------------------------------------------
  const today = toLocalDate(new Date(), TIMEZONE);
  for (let i = 0; i < 14; i++) {
    const date = toLocalDate(new Date(Date.now() - i * 86_400_000), TIMEZONE);
    await db
      .insert(checkIns)
      .values({
        athleteId,
        date,
        // Mild weekly rhythm rather than random noise.
        energy: 3 + ((i % 5 === 0 ? -1 : 0) + (i % 3 === 0 ? 1 : 0)),
        soreness: 4 - (i % 4 === 0 ? 1 : 0),
        stress: 3 + (i % 7 === 0 ? 1 : 0),
        motivation: 4,
        hasPain: false,
      })
      .onConflictDoNothing();
  }

  // --- Training plan -------------------------------------------------------
  const [existingPlan] = await db
    .select()
    .from(trainingPlans)
    .where(eq(trainingPlans.athleteId, athleteId))
    .limit(1);

  let planId: string | undefined = existingPlan?.id;

  if (!existingPlan) {
    const context = await loadAthleteContext(athleteId);
    const [race] = await db.select().from(raceGoals).where(eq(raceGoals.athleteId, athleteId)).limit(1);

    const recentWeekly = computeWeeklyDistances(
      context.recentRuns,
      TIMEZONE,
      context.today,
      4,
    );
    const currentWeekly =
      recentWeekly.filter((v) => v > 0).reduce((a, b, _i, arr) => a + b / arr.length, 0) || 30_000;

    const plan = generateTrainingPlan({
      athleteId,
      template: 'road_10k',
      startDate: today,
      totalWeeks: race ? weeksUntil(today, race.date) : 12,
      availability: context.profile.availability as never,
      constraints: context.profile.constraints as never,
      fitness: context.fitness,
      currentWeeklyDistanceMeters: currentWeekly,
      raceGoalId: race?.id,
      raceDate: race?.date,
      raceDistanceMeters: race?.distanceMeters,
      idFactory: () => randomUUID(),
    });

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

    planId = plan.id;
    log('seed.plan_generated', {
      planId,
      blocks: plan.blocks.length,
      workouts: plan.workouts.length,
    });
  }

  const context = await loadAthleteContext(athleteId);

  return {
    userId,
    athleteId,
    planId,
    workoutCount: context.recentRuns.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => seed())
    .then((result) => {
      logger.info('seed.complete', { ...result });
      console.warn(
        `\nSeed complete.\n  Email:    ${SEED_EMAIL}\n  Password: ${SEED_PASSWORD}\n  Workouts: ${result.workoutCount}\n`,
      );
      process.exit(0);
    })
    .catch((error: unknown) => {
      logger.error('seed.failed', { error: String(error) });
      console.error(error);
      process.exit(1);
    });
}
