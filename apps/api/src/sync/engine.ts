/**
 * Sync engine.
 *
 * Owns the path from "a provider has data" to "the athlete's canonical
 * training history is up to date and every derived metric has been
 * recomputed".
 *
 * Idempotency is the central requirement. Webhooks get redelivered, sync
 * windows overlap, and the same activity arrives from three providers. Every
 * write below is therefore an upsert keyed on (connection, external id), and
 * canonical workouts are rebuilt from the provider rows rather than appended
 * to — so running a sync twice produces exactly the same database state as
 * running it once.
 */

import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import {
  clusterWorkouts,
  computeSessionLoad,
  computeTrainingLoadState,
  mergeCluster,
  toDailySeries,
  toLocalDate,
  type CanonicalWorkout,
  type ProviderWorkout,
  type SessionLoad,
} from '@running/core';

import { getDb, type Database } from '../db/client.js';
import {
  athleteProfiles,
  bodyMeasurements,
  canonicalWorkouts,
  providerConnections,
  syncJobs,
  trainingLoads,
  whoopRecoveries,
  whoopSleep,
  workoutSources,
} from '../db/schema.js';
import { getProvider } from '../providers/registry.js';
import {
  ProviderAuthError,
  ProviderRateLimitError,
  type OAuthTokens,
  type ProviderSyncPayload,
} from '../providers/types.js';
import { decryptSecret, encryptSecret } from '../security/crypto.js';
import { logger } from '../observability/logger.js';
import type { ProviderId } from '@running/core';

export interface SyncOutcome {
  provider: ProviderId;
  status: 'success' | 'partial' | 'failed';
  recordsFetched: number;
  recordsCreated: number;
  recordsUpdated: number;
  duplicatesMerged: number;
  errors: string[];
  startedAt: Date;
  finishedAt: Date;
}

/** How far back a first-time sync reaches. */
const FULL_SYNC_DAYS = 365;
/** Overlap on incremental syncs, so a late-arriving edit isn't missed. */
const INCREMENTAL_OVERLAP_HOURS = 48;

/**
 * Ensure a connection's access token is currently valid, refreshing it if it
 * is expired or close to it. Returns undefined when the athlete must reconnect.
 */
export async function ensureValidTokens(
  db: Database,
  connectionId: string,
): Promise<OAuthTokens | undefined> {
  const [connection] = await db
    .select()
    .from(providerConnections)
    .where(eq(providerConnections.id, connectionId))
    .limit(1);

  if (!connection?.accessTokenEncrypted) return undefined;

  const provider = getProvider(connection.provider as ProviderId);
  if (!provider) return undefined;

  const tokens: OAuthTokens = {
    accessToken: decryptSecret(connection.accessTokenEncrypted),
    refreshToken: decryptSecret(connection.refreshTokenEncrypted) ?? undefined,
    expiresAt: connection.tokenExpiresAt ?? undefined,
    scopes: (connection.scopes as string[]) ?? [],
    externalUserId: connection.externalUserId ?? undefined,
  };

  // Refresh a few minutes early rather than racing the expiry.
  const expiresSoon =
    tokens.expiresAt !== undefined && tokens.expiresAt.getTime() - Date.now() < 5 * 60 * 1000;

  if (!expiresSoon || !tokens.refreshToken) return tokens;

  try {
    const refreshed = await provider.refreshTokens(tokens.refreshToken);
    await db
      .update(providerConnections)
      .set({
        accessTokenEncrypted: encryptSecret(refreshed.accessToken),
        // Providers may rotate the refresh token; keep the old one if not.
        refreshTokenEncrypted: refreshed.refreshToken
          ? encryptSecret(refreshed.refreshToken)
          : connection.refreshTokenEncrypted,
        tokenExpiresAt: refreshed.expiresAt ?? null,
        status: 'connected',
        lastSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(providerConnections.id, connectionId));

    logger.info('provider.token.refreshed', { provider: connection.provider });
    return { ...refreshed, externalUserId: refreshed.externalUserId ?? tokens.externalUserId };
  } catch (error) {
    const isAuthFailure = error instanceof ProviderAuthError;
    await db
      .update(providerConnections)
      .set({
        status: isAuthFailure ? 'expired' : 'error',
        lastSyncError: isAuthFailure
          ? 'Authorization expired. Reconnect to resume syncing.'
          : 'Could not refresh access. We will retry automatically.',
        updatedAt: new Date(),
      })
      .where(eq(providerConnections.id, connectionId));

    logger.warn('provider.token.refresh_failed', {
      provider: connection.provider,
      error: String(error),
    });
    return undefined;
  }
}

/**
 * Run one sync pass for a provider.
 * Never throws for expected failure modes — it records them on the connection
 * and in the job row so the UI can explain what happened.
 */
export async function syncProvider(args: {
  athleteId: string;
  provider: ProviderId;
  kind: 'full' | 'incremental';
}): Promise<SyncOutcome> {
  const { db } = await getDb();
  const startedAt = new Date();
  const errors: string[] = [];

  const outcome = (
    status: SyncOutcome['status'],
    counts: Partial<SyncOutcome> = {},
  ): SyncOutcome => ({
    provider: args.provider,
    status,
    recordsFetched: 0,
    recordsCreated: 0,
    recordsUpdated: 0,
    duplicatesMerged: 0,
    errors,
    startedAt,
    finishedAt: new Date(),
    ...counts,
  });

  const [connection] = await db
    .select()
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.athleteId, args.athleteId),
        eq(providerConnections.provider, args.provider),
      ),
    )
    .limit(1);

  if (!connection || connection.status === 'disconnected') {
    errors.push(`${args.provider} is not connected.`);
    return outcome('failed');
  }

  const provider = getProvider(args.provider);
  if (!provider) {
    errors.push(`No implementation registered for ${args.provider}.`);
    return outcome('failed');
  }

  // HealthKit has no server-pull path; the device pushes instead.
  if (!provider.capabilities.serverPull) {
    return outcome('success');
  }

  const tokens = await ensureValidTokens(db, connection.id);
  if (!tokens) {
    errors.push(`${provider.displayName} authorization needs to be renewed.`);
    return outcome('failed');
  }

  const [athlete] = await db
    .select()
    .from(athleteProfiles)
    .where(eq(athleteProfiles.id, args.athleteId))
    .limit(1);
  const timezone = athlete?.timezone ?? 'UTC';

  const since =
    args.kind === 'full'
      ? new Date(Date.now() - FULL_SYNC_DAYS * 24 * 60 * 60 * 1000)
      : new Date(
          (connection.lastSyncedAt?.getTime() ?? Date.now() - 30 * 24 * 60 * 60 * 1000) -
            INCREMENTAL_OVERLAP_HOURS * 60 * 60 * 1000,
        );

  await db
    .update(providerConnections)
    .set({ status: 'syncing', updatedAt: new Date() })
    .where(eq(providerConnections.id, connection.id));

  let payload: ProviderSyncPayload;
  try {
    payload = await provider.sync({
      tokens,
      window: { since, cursor: connection.syncCursor },
      athleteId: args.athleteId,
      timezone,
    });
  } catch (error) {
    const message =
      error instanceof ProviderRateLimitError
        ? `${provider.displayName} rate limit reached. Syncing will resume automatically.`
        : error instanceof ProviderAuthError
          ? `${provider.displayName} authorization is no longer valid. Reconnect to resume syncing.`
          : `${provider.displayName} sync failed. We will retry automatically.`;

    errors.push(message);
    await db
      .update(providerConnections)
      .set({
        status: error instanceof ProviderAuthError ? 'expired' : 'error',
        lastSyncError: message,
        updatedAt: new Date(),
      })
      .where(eq(providerConnections.id, connection.id));

    logger.warn('sync.provider.failed', { provider: args.provider, error: String(error) });
    return outcome('failed');
  }

  errors.push(...payload.warnings);

  // --- Persist normalised records -----------------------------------------
  const persisted = await persistPayload(db, {
    athleteId: args.athleteId,
    connectionId: connection.id,
    provider: args.provider,
    payload,
    timezone,
  });

  await db
    .update(providerConnections)
    .set({
      status: 'connected',
      lastSyncedAt: new Date(),
      lastSyncError: payload.warnings.length > 0 ? payload.warnings[0]! : null,
      syncCursor: payload.nextCursor ?? connection.syncCursor,
      updatedAt: new Date(),
    })
    .where(eq(providerConnections.id, connection.id));

  // --- Rebuild canonical workouts and derived metrics ----------------------
  const rebuild = await rebuildCanonicalWorkouts(db, args.athleteId, timezone, since);
  await recomputeTrainingLoads(db, args.athleteId);

  logger.info('sync.provider.complete', {
    provider: args.provider,
    fetched: payload.workouts.length,
    canonical: rebuild.canonicalCount,
    merged: rebuild.duplicatesMerged,
  });

  return outcome(payload.warnings.length > 0 ? 'partial' : 'success', {
    recordsFetched:
      payload.workouts.length + payload.recoveries.length + payload.sleep.length,
    recordsCreated: persisted.created,
    recordsUpdated: persisted.updated,
    duplicatesMerged: rebuild.duplicatesMerged,
  });
}

/**
 * Persist a provider payload.
 *
 * Exported so the seed script can drive the identical persistence path rather
 * than inserting its own hand-built rows — a seed that bypasses this would
 * stop catching regressions in it.
 */
export async function persistPayload(
  db: Database,
  args: {
    athleteId: string;
    connectionId: string;
    provider: ProviderId;
    payload: ProviderSyncPayload;
    timezone: string;
  },
): Promise<{ created: number; updated: number }> {
  let created = 0;
  const updated = 0;

  // --- Recovery ------------------------------------------------------------
  for (const recovery of args.payload.recoveries) {
    await db
      .insert(whoopRecoveries)
      .values({
        connectionId: args.connectionId,
        athleteId: args.athleteId,
        cycleExternalId: recovery.externalId,
        localDate: recovery.localDate,
        scoreState: 'SCORED',
        recoveryScore: recovery.recoveryScore ?? null,
        restingHeartRate: recovery.restingHeartRateBpm ?? null,
        hrvRmssdMilli: recovery.hrvRmssdMs ?? null,
        spo2Percentage: recovery.spo2Percent ?? null,
        skinTempCelsius: recovery.skinTempCelsius ?? null,
        userCalibrating: recovery.calibrating ?? false,
        raw: recovery.raw as object,
      })
      // Re-running a sync updates in place rather than duplicating.
      .onConflictDoUpdate({
        target: [whoopRecoveries.connectionId, whoopRecoveries.cycleExternalId],
        set: {
          recoveryScore: recovery.recoveryScore ?? null,
          restingHeartRate: recovery.restingHeartRateBpm ?? null,
          hrvRmssdMilli: recovery.hrvRmssdMs ?? null,
          localDate: recovery.localDate,
          updatedAt: new Date(),
        },
      });
    created++;
  }

  // --- Sleep ---------------------------------------------------------------
  for (const record of args.payload.sleep) {
    await db
      .insert(whoopSleep)
      .values({
        connectionId: args.connectionId,
        athleteId: args.athleteId,
        externalId: record.externalId,
        localDate: record.localDate,
        start: record.start,
        end: record.end,
        nap: record.isNap,
        scoreState: 'SCORED',
        totalInBedTimeMilli: (record.timeInBedSeconds ?? 0) * 1000,
        totalAwakeTimeMilli: (record.awakeSeconds ?? 0) * 1000,
        totalLightSleepTimeMilli: (record.lightSleepSeconds ?? 0) * 1000,
        totalSlowWaveSleepTimeMilli: (record.deepSleepSeconds ?? 0) * 1000,
        totalRemSleepTimeMilli: (record.remSleepSeconds ?? 0) * 1000,
        disturbanceCount: record.disturbanceCount ?? null,
        sleepPerformancePercentage: record.performancePercent ?? null,
        sleepConsistencyPercentage: record.consistencyPercent ?? null,
        sleepEfficiencyPercentage: record.efficiencyPercent ?? null,
        respiratoryRate: record.respiratoryRate ?? null,
        raw: record.raw as object,
      })
      .onConflictDoUpdate({
        target: [whoopSleep.connectionId, whoopSleep.externalId],
        set: {
          totalLightSleepTimeMilli: (record.lightSleepSeconds ?? 0) * 1000,
          totalSlowWaveSleepTimeMilli: (record.deepSleepSeconds ?? 0) * 1000,
          totalRemSleepTimeMilli: (record.remSleepSeconds ?? 0) * 1000,
          sleepPerformancePercentage: record.performancePercent ?? null,
          updatedAt: new Date(),
        },
      });
    created++;
  }

  // --- Body measurements ---------------------------------------------------
  for (const measurement of args.payload.bodyMeasurements) {
    await db
      .insert(bodyMeasurements)
      .values({
        athleteId: args.athleteId,
        metric: measurement.metric,
        provider: args.provider,
        originalValue: measurement.originalValue,
        normalizedValue: measurement.normalizedValue,
        transformation: measurement.transformation ?? null,
        measuredAt: measurement.measuredAt,
      })
      // Same provider, same metric, same instant is the same observation.
      .onConflictDoNothing();
    created++;
  }

  // --- Workouts ------------------------------------------------------------
  for (const workout of args.payload.workouts) {
    await upsertProviderWorkout(db, args.athleteId, args.connectionId, workout);
    created++;
  }

  return { created, updated };
}

/**
 * Neutral cache of normalised provider workouts.
 *
 * Stored as canonical workouts with a single source, then re-clustered. This
 * keeps one code path for "workout from any provider" instead of a bespoke
 * table per integration.
 */
async function upsertProviderWorkout(
  db: Database,
  athleteId: string,
  _connectionId: string,
  workout: ProviderWorkout,
): Promise<void> {
  // `workout_sources` has a unique index on (provider, externalId), which is
  // what makes re-ingesting the same activity a no-op.
  const [existing] = await db
    .select({ canonicalWorkoutId: workoutSources.canonicalWorkoutId })
    .from(workoutSources)
    .where(
      and(
        eq(workoutSources.provider, workout.provider),
        eq(workoutSources.externalId, workout.externalId),
      ),
    )
    .limit(1);

  if (existing) {
    // Already ingested. The rebuild pass below re-merges it if anything moved.
    return;
  }

  const id = randomUUID();
  const localDate = toLocalDate(workout.startTime, workout.timezone ?? 'UTC');

  await db.insert(canonicalWorkouts).values({
    id,
    athleteId,
    type: workout.type,
    sport: workout.sport,
    name: workout.name ?? null,
    startTime: workout.startTime,
    endTime: workout.endTime,
    timezone: workout.timezone ?? 'UTC',
    localDate,
    durationSeconds: workout.durationSeconds ?? null,
    movingTimeSeconds: workout.movingTimeSeconds ?? null,
    distanceMeters: workout.distanceMeters ?? null,
    avgHeartRateBpm: workout.avgHeartRateBpm ?? null,
    maxHeartRateBpm: workout.maxHeartRateBpm ?? null,
    elevationGainMeters: workout.elevationGainMeters ?? null,
    avgCadenceSpm: workout.avgCadenceSpm ?? null,
    avgPowerWatts: workout.avgPowerWatts ?? null,
    calories: workout.calories ?? null,
    perceivedExertion: workout.perceivedExertion ?? null,
    indoor: workout.indoor ?? null,
    temperatureCelsius: workout.temperatureCelsius ?? null,
    splits: (workout.splits as object) ?? null,
    samples: (workout.samples as object) ?? null,
    route: (workout.route as object) ?? null,
    sourceConfidence: 0.6,
  });

  await db.insert(workoutSources).values({
    canonicalWorkoutId: id,
    provider: workout.provider,
    externalId: workout.externalId,
    contributedFields: [],
  });
}

/**
 * Re-cluster and re-merge canonical workouts in a date range.
 *
 * Running this repeatedly is safe and is the mechanism that makes late-arriving
 * provider data (a WHOOP record showing up two hours after Strava's) collapse
 * into the existing workout rather than creating a second one.
 */
export async function rebuildCanonicalWorkouts(
  db: Database,
  athleteId: string,
  timezone: string,
  since: Date,
): Promise<{ canonicalCount: number; duplicatesMerged: number }> {
  const rows = await db
    .select()
    .from(canonicalWorkouts)
    .where(and(eq(canonicalWorkouts.athleteId, athleteId), gte(canonicalWorkouts.startTime, since)));

  if (rows.length === 0) return { canonicalCount: 0, duplicatesMerged: 0 };

  const sources = await db
    .select()
    .from(workoutSources)
    .where(
      inArray(
        workoutSources.canonicalWorkoutId,
        rows.map((r) => r.id),
      ),
    );

  const sourcesByWorkout = new Map<string, typeof sources>();
  for (const source of sources) {
    const list = sourcesByWorkout.get(source.canonicalWorkoutId) ?? [];
    list.push(source);
    sourcesByWorkout.set(source.canonicalWorkoutId, list);
  }

  // Rehydrate each stored row as a provider-shaped record so the dedup engine
  // can reason about them uniformly.
  const providerWorkouts: (ProviderWorkout & { _rowId: string })[] = [];
  for (const row of rows) {
    const rowSources = sourcesByWorkout.get(row.id) ?? [];
    for (const source of rowSources) {
      providerWorkouts.push({
        _rowId: row.id,
        provider: source.provider as ProviderId,
        externalId: source.externalId,
        athleteId,
        type: row.type as ProviderWorkout['type'],
        sport: row.sport as ProviderWorkout['sport'],
        name: row.name ?? undefined,
        startTime: row.startTime,
        endTime: row.endTime,
        timezone: row.timezone,
        durationSeconds: row.durationSeconds ?? undefined,
        movingTimeSeconds: row.movingTimeSeconds ?? undefined,
        distanceMeters: row.distanceMeters ?? undefined,
        avgHeartRateBpm: row.avgHeartRateBpm ?? undefined,
        maxHeartRateBpm: row.maxHeartRateBpm ?? undefined,
        elevationGainMeters: row.elevationGainMeters ?? undefined,
        avgCadenceSpm: row.avgCadenceSpm ?? undefined,
        avgPowerWatts: row.avgPowerWatts ?? undefined,
        calories: row.calories ?? undefined,
        perceivedExertion: row.perceivedExertion ?? undefined,
        splits: (row.splits as ProviderWorkout['splits']) ?? undefined,
        samples: (row.samples as ProviderWorkout['samples']) ?? undefined,
        route: (row.route as ProviderWorkout['route']) ?? undefined,
        indoor: row.indoor ?? undefined,
        temperatureCelsius: row.temperatureCelsius ?? undefined,
        syncedAt: row.updatedAt,
      });
    }
  }

  const clusters = clusterWorkouts(providerWorkouts);
  let duplicatesMerged = 0;

  for (const cluster of clusters) {
    if (cluster.length === 0) continue;

    // Keep the oldest row id as the surviving canonical workout, so links from
    // planned workouts and analyses stay intact.
    const rowIds = [...new Set(cluster.map((c) => (c as ProviderWorkout & { _rowId: string })._rowId))];
    const survivingId = rowIds[0]!;

    const merged: CanonicalWorkout = mergeCluster(cluster, {
      id: survivingId,
      defaultTimezone: timezone,
    });

    await db
      .update(canonicalWorkouts)
      .set({
        type: merged.type,
        sport: merged.sport,
        name: merged.name ?? null,
        startTime: merged.startTime,
        endTime: merged.endTime,
        timezone: merged.timezone,
        localDate: toLocalDate(merged.startTime, merged.timezone),
        durationSeconds: merged.durationSeconds ? Math.round(merged.durationSeconds) : null,
        movingTimeSeconds: merged.movingTimeSeconds
          ? Math.round(merged.movingTimeSeconds)
          : null,
        distanceMeters: merged.distanceMeters ?? null,
        avgHeartRateBpm: merged.avgHeartRateBpm ?? null,
        maxHeartRateBpm: merged.maxHeartRateBpm ?? null,
        avgPaceSecondsPerKm: merged.avgPaceSecondsPerKm ?? null,
        elevationGainMeters: merged.elevationGainMeters ?? null,
        avgCadenceSpm: merged.avgCadenceSpm ?? null,
        avgPowerWatts: merged.avgPowerWatts ?? null,
        calories: merged.calories ?? null,
        sourceConfidence: merged.sourceConfidence,
        updatedAt: new Date(),
      })
      .where(eq(canonicalWorkouts.id, survivingId));

    // Repoint every source in the cluster at the surviving workout, then drop
    // the now-empty duplicate rows.
    for (const source of merged.sourceRecords) {
      await db
        .update(workoutSources)
        .set({
          canonicalWorkoutId: survivingId,
          contributedFields: source.contributedFields,
        })
        .where(
          and(
            eq(workoutSources.provider, source.provider),
            eq(workoutSources.externalId, source.externalId),
          ),
        );
    }

    const obsolete = rowIds.slice(1);
    if (obsolete.length > 0) {
      await db.delete(canonicalWorkouts).where(inArray(canonicalWorkouts.id, obsolete));
      duplicatesMerged += obsolete.length;
    }
  }

  return { canonicalCount: clusters.length, duplicatesMerged };
}

/**
 * Recompute per-session load and the rolling load state.
 * Cheap enough to run after every sync, and always consistent with the
 * canonical workouts as they currently stand.
 */
export async function recomputeTrainingLoads(db: Database, athleteId: string): Promise<void> {
  const [athlete] = await db
    .select()
    .from(athleteProfiles)
    .where(eq(athleteProfiles.id, athleteId))
    .limit(1);
  if (!athlete) return;

  const since = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(canonicalWorkouts)
    .where(and(eq(canonicalWorkouts.athleteId, athleteId), gte(canonicalWorkouts.startTime, since)))
    .orderBy(canonicalWorkouts.startTime);

  const loads: SessionLoad[] = [];

  for (const row of rows) {
    const workout = rowToCanonicalWorkout(row);
    const load = computeSessionLoad(workout, {
      sex: (athlete.sex as 'male' | 'female' | 'unspecified') ?? 'unspecified',
      maxHeartRateBpm: athlete.maxHeartRateBpm ?? undefined,
      restingHeartRateBpm: athlete.restingHeartRateBpm ?? undefined,
    });
    if (!load) continue;

    loads.push(load);
    await db
      .update(canonicalWorkouts)
      .set({ trainingLoad: load.load, loadModel: load.model })
      .where(eq(canonicalWorkouts.id, row.id));
  }

  if (loads.length === 0) return;

  const from = loads[0]!.date;
  const to = toLocalDate(new Date(), athlete.timezone);
  const daily = toDailySeries(loads, from, to);

  // Persist the rolling state for each day so the Progress screen can chart it
  // without recomputing the whole history on every request.
  for (let i = 0; i < daily.length; i++) {
    const slice = daily.slice(0, i + 1);
    const state = computeTrainingLoadState(slice);
    const day = daily[i]!;
    if (!state) continue;

    await db
      .insert(trainingLoads)
      .values({
        athleteId,
        date: day.date,
        dailyLoad: day.load,
        acuteLoad: state.acuteLoad,
        chronicLoad: state.chronicLoad,
        acuteChronicRatio: state.acuteChronicRatio ?? null,
        monotony: state.monotony ?? null,
        strain: state.strain ?? null,
        weeklyLoad: state.weeklyLoad,
      })
      .onConflictDoUpdate({
        target: [trainingLoads.athleteId, trainingLoads.date],
        set: {
          dailyLoad: day.load,
          acuteLoad: state.acuteLoad,
          chronicLoad: state.chronicLoad,
          acuteChronicRatio: state.acuteChronicRatio ?? null,
          monotony: state.monotony ?? null,
          strain: state.strain ?? null,
          weeklyLoad: state.weeklyLoad,
          computedAt: new Date(),
        },
      });
  }
}

/** Map a database row back onto the domain type. */
export function rowToCanonicalWorkout(
  row: typeof canonicalWorkouts.$inferSelect,
): CanonicalWorkout {
  return {
    id: row.id,
    athleteId: row.athleteId,
    sourceRecords: [],
    type: row.type as CanonicalWorkout['type'],
    sport: row.sport as CanonicalWorkout['sport'],
    name: row.name ?? undefined,
    startTime: row.startTime,
    endTime: row.endTime,
    timezone: row.timezone,
    durationSeconds: row.durationSeconds ?? undefined,
    movingTimeSeconds: row.movingTimeSeconds ?? undefined,
    distanceMeters: row.distanceMeters ?? undefined,
    avgHeartRateBpm: row.avgHeartRateBpm ?? undefined,
    maxHeartRateBpm: row.maxHeartRateBpm ?? undefined,
    avgPaceSecondsPerKm: row.avgPaceSecondsPerKm ?? undefined,
    elevationGainMeters: row.elevationGainMeters ?? undefined,
    avgCadenceSpm: row.avgCadenceSpm ?? undefined,
    avgPowerWatts: row.avgPowerWatts ?? undefined,
    calories: row.calories ?? undefined,
    perceivedExertion: row.perceivedExertion ?? undefined,
    trainingLoad: row.trainingLoad ?? undefined,
    splits: (row.splits as CanonicalWorkout['splits']) ?? undefined,
    samples: (row.samples as CanonicalWorkout['samples']) ?? undefined,
    route: (row.route as CanonicalWorkout['route']) ?? undefined,
    indoor: row.indoor ?? undefined,
    temperatureCelsius: row.temperatureCelsius ?? undefined,
    sourceConfidence: row.sourceConfidence,
    plannedWorkoutId: row.plannedWorkoutId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Job queue
// ---------------------------------------------------------------------------

/** Exponential backoff with a ceiling, in milliseconds. */
export function backoffDelayMs(attempt: number): number {
  return Math.min(2 ** attempt * 1000, 15 * 60 * 1000);
}

export const MAX_SYNC_ATTEMPTS = 5;

export async function enqueueSync(args: {
  athleteId: string;
  provider: ProviderId;
  kind: 'full' | 'incremental' | 'webhook';
  payload?: unknown;
}): Promise<string> {
  const { db } = await getDb();
  const [job] = await db
    .insert(syncJobs)
    .values({
      athleteId: args.athleteId,
      provider: args.provider,
      kind: args.kind,
      status: 'queued',
      payload: (args.payload as object) ?? null,
    })
    // No-arg form: `Database` is a union of the PGlite and postgres-js
    // drivers, and the projected overload does not survive the union.
    .returning();

  return job!.id;
}

/**
 * Drain queued jobs.
 *
 * Deliberately a simple in-process worker: it keeps the whole stack runnable
 * with `pnpm api:dev` and no broker. The `sync_jobs` table is the durable
 * queue, so moving to a real worker process later means changing who calls
 * this, not how work is represented.
 */
export async function processQueuedJobs(limit = 5): Promise<number> {
  const { db } = await getDb();
  const now = new Date();

  const jobs = await db
    .select()
    .from(syncJobs)
    .where(and(eq(syncJobs.status, 'queued'), sql`${syncJobs.runAfter} <= ${now}`))
    .orderBy(syncJobs.runAfter)
    .limit(limit);

  let processed = 0;

  for (const job of jobs) {
    await db
      .update(syncJobs)
      .set({ status: 'running', startedAt: new Date(), attempts: job.attempts + 1 })
      .where(eq(syncJobs.id, job.id));

    try {
      const result = await syncProvider({
        athleteId: job.athleteId,
        provider: job.provider as ProviderId,
        kind: job.kind === 'full' ? 'full' : 'incremental',
      });

      const failed = result.status === 'failed';
      const canRetry = failed && job.attempts + 1 < MAX_SYNC_ATTEMPTS;

      await db
        .update(syncJobs)
        .set({
          status: canRetry ? 'queued' : failed ? 'failed' : 'succeeded',
          runAfter: canRetry ? new Date(Date.now() + backoffDelayMs(job.attempts + 1)) : job.runAfter,
          recordsFetched: result.recordsFetched,
          recordsCreated: result.recordsCreated,
          recordsUpdated: result.recordsUpdated,
          duplicatesMerged: result.duplicatesMerged,
          errors: result.errors,
          finishedAt: canRetry ? null : new Date(),
          updatedAt: new Date(),
        })
        .where(eq(syncJobs.id, job.id));

      processed++;
    } catch (error) {
      const canRetry = job.attempts + 1 < MAX_SYNC_ATTEMPTS;
      await db
        .update(syncJobs)
        .set({
          status: canRetry ? 'queued' : 'failed',
          runAfter: new Date(Date.now() + backoffDelayMs(job.attempts + 1)),
          errors: [String(error)],
          finishedAt: canRetry ? null : new Date(),
          updatedAt: new Date(),
        })
        .where(eq(syncJobs.id, job.id));

      logger.error('sync.job.failed', { jobId: job.id, error: String(error) });
    }
  }

  return processed;
}

/** Most recent sync job per provider, for the Connections screen. */
export async function recentSyncJobs(athleteId: string, limit = 10) {
  const { db } = await getDb();
  return db
    .select()
    .from(syncJobs)
    .where(eq(syncJobs.athleteId, athleteId))
    .orderBy(desc(syncJobs.createdAt))
    .limit(limit);
}
