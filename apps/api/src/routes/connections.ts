/**
 * Provider connection lifecycle: connect, callback, sync, disconnect, delete.
 *
 * The OAuth state parameter is signed rather than stored, so the callback can
 * be verified without a session table and a forged callback cannot bind
 * someone else's provider account to an athlete.
 */

import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { ProviderId } from '@running/core';
import { toLocalDate } from '@running/core';

import { getDb } from '../db/client.js';
import {
  athleteProfiles,
  auditLogs,
  bodyMeasurements,
  canonicalWorkouts,
  healthkitSamples,
  providerConnections,
  whoopRecoveries,
  whoopSleep,
  workoutSources,
} from '../db/schema.js';
import type { AuthVariables } from '../security/auth.js';
import { decryptSecret, encryptSecret, generateOAuthState } from '../security/crypto.js';
import { getProvider, isConnectableProvider, listProviders } from '../providers/registry.js';
import { enqueueSync, recentSyncJobs, syncProvider, recomputeTrainingLoads, rebuildCanonicalWorkouts } from '../sync/engine.js';
import { badRequest, notFound } from '../errors.js';
import { env } from '../env.js';
import { logger } from '../observability/logger.js';

export const connectionRoutes = new Hono<{ Variables: AuthVariables }>();

// ---------------------------------------------------------------------------
// Signed OAuth state
// ---------------------------------------------------------------------------

function stateSecret(): string {
  return env().AUTH_JWT_SECRET ?? 'running-os-development-jwt-secret-not-for-production-use';
}

/** `athleteId.provider.nonce.signature` — self-verifying, no server storage. */
function signState(athleteId: string, provider: string): string {
  const nonce = generateOAuthState().slice(0, 16);
  const payload = `${athleteId}.${provider}.${nonce}`;
  const signature = createHmac('sha256', stateSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyState(state: string): { athleteId: string; provider: string } | undefined {
  const parts = state.split('.');
  if (parts.length !== 4) return undefined;

  const [athleteId, provider, nonce, signature] = parts as [string, string, string, string];
  const expected = createHmac('sha256', stateSecret())
    .update(`${athleteId}.${provider}.${nonce}`)
    .digest('base64url');

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;

  return { athleteId, provider };
}

// ---------------------------------------------------------------------------
// Authenticated routes
// ---------------------------------------------------------------------------

// Auth is applied centrally in app.ts. Routes are declared directly on
// connectionRoutes so the public /:provider/callback is not shadowed by a
// group-level wildcard middleware.
connectionRoutes.get('/', async (c) => {
  const athleteId = c.get('athleteId');
  const { db } = await getDb();

  const rows = await db
    .select()
    .from(providerConnections)
    .where(eq(providerConnections.athleteId, athleteId));

  const jobs = await recentSyncJobs(athleteId, 20);

  const connections = listProviders().map((provider) => {
    const row = rows.find((r) => r.provider === provider.id);
    const lastJob = jobs.find((j) => j.provider === provider.id);

    return {
      provider: provider.id,
      displayName: provider.displayName,
      status: row?.status ?? 'disconnected',
      connectedAt: row?.connectedAt?.toISOString(),
      lastSyncedAt: row?.lastSyncedAt?.toISOString(),
      lastSyncError: row?.lastSyncError ?? undefined,
      scopes: (row?.scopes as string[]) ?? [],
      dataDescription: [...provider.dataDescription],
      capabilities: provider.capabilities,
      isConfigured: provider.isConfigured(),
      lastSync: lastJob
        ? {
            status: lastJob.status,
            recordsFetched: lastJob.recordsFetched,
            duplicatesMerged: lastJob.duplicatesMerged,
            errors: lastJob.errors,
            finishedAt: lastJob.finishedAt?.toISOString(),
          }
        : undefined,
    };
  });

  return c.json({ connections });
});

/** Begin the OAuth flow. Returns a URL the app opens in a browser. */
connectionRoutes.post('/:provider/connect', async (c) => {
  const provider = c.req.param('provider');
  if (!isConnectableProvider(provider)) throw notFound('Provider');

  const implementation = getProvider(provider);
  if (!implementation) throw notFound('Provider');

  const athleteId = c.get('athleteId');
  const { db } = await getDb();

  // Apple Health has no OAuth: it is authorised on-device.
  if (!implementation.capabilities.serverPull && provider === 'healthkit') {
    await upsertConnection(db, athleteId, provider, {
      status: 'connected',
      scopes: [...implementation.scopes],
      connectedAt: new Date(),
    });
    return c.json({
      requiresDeviceAuthorization: true,
      message:
        'Apple Health is authorised on your iPhone. Grant permission in the app when prompted.',
    });
  }

  if (!implementation.isConfigured()) {
    throw badRequest(
      `${implementation.displayName} is not configured on this server. Add its client credentials to enable it.`,
    );
  }

  /**
   * Mock mode has no browser round-trip to make, so the connection is
   * established here directly. This is what lets the whole product — sync,
   * dedup, coaching — be developed and tested before any provider
   * application has been approved.
   */
  if (env().USE_MOCK_DATA) {
    const tokens = await implementation.exchangeCode('mock-code');
    await upsertConnection(db, athleteId, provider, {
      status: 'connected',
      connectedAt: new Date(),
      scopes: tokens.scopes,
      externalUserId: tokens.externalUserId ?? null,
      accessTokenEncrypted: encryptSecret(tokens.accessToken),
      refreshTokenEncrypted: encryptSecret(tokens.refreshToken),
      tokenExpiresAt: tokens.expiresAt ?? null,
      lastSyncError: null,
    });

    return c.json({
      connected: true,
      mockMode: true,
      message: `${implementation.displayName} connected with synthetic data (USE_MOCK_DATA is on).`,
    });
  }

  const state = signState(athleteId, provider);
  const url = implementation.buildAuthorizationUrl({ state });

  return c.json({ authorizationUrl: url, state });
});

/** Force a sync now. */
connectionRoutes.post('/:provider/sync', async (c) => {
  const provider = c.req.param('provider');
  if (!isConnectableProvider(provider)) throw notFound('Provider');

  const athleteId = c.get('athleteId');
  const full = c.req.query('full') === 'true';

  const result = await syncProvider({
    athleteId,
    provider: provider as ProviderId,
    kind: full ? 'full' : 'incremental',
  });

  return c.json({
    provider: result.provider,
    status: result.status,
    started: result.startedAt.toISOString(),
    finished: result.finishedAt.toISOString(),
    recordsFetched: result.recordsFetched,
    recordsCreated: result.recordsCreated,
    recordsUpdated: result.recordsUpdated,
    duplicatesMerged: result.duplicatesMerged,
    errors: result.errors,
  });
});

/**
 * Disconnect.
 *
 * Revokes remotely (best effort), clears the stored tokens, and — when asked —
 * deletes the data that came from that provider. Deleting is explicit rather
 * than automatic, because an athlete usually wants to keep their training
 * history after unlinking a service.
 */
connectionRoutes.delete('/:provider', async (c) => {
  const provider = c.req.param('provider');
  if (!isConnectableProvider(provider)) throw notFound('Provider');

  const athleteId = c.get('athleteId');
  const deleteData = c.req.query('deleteData') === 'true';
  const { db } = await getDb();

  const [connection] = await db
    .select()
    .from(providerConnections)
    .where(
      and(eq(providerConnections.athleteId, athleteId), eq(providerConnections.provider, provider)),
    )
    .limit(1);

  if (!connection) throw notFound('Connection');

  const implementation = getProvider(provider as ProviderId);
  if (implementation && connection.accessTokenEncrypted) {
    try {
      await implementation.revoke(decryptSecret(connection.accessTokenEncrypted));
    } catch (error) {
      logger.warn('connection.revoke.failed', { provider, error: String(error) });
    }
  }

  await db
    .update(providerConnections)
    .set({
      status: 'disconnected',
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      tokenExpiresAt: null,
      syncCursor: null,
      lastSyncError: null,
      updatedAt: new Date(),
    })
    .where(eq(providerConnections.id, connection.id));

  let deleted = 0;
  if (deleteData) {
    deleted = await deleteProviderData(db, athleteId, connection.id, provider);
  }

  await db.insert(auditLogs).values({
    userId: c.get('userId'),
    athleteId,
    action: deleteData ? 'connection.disconnect_and_delete' : 'connection.disconnect',
    resource: provider,
    metadata: { recordsDeleted: deleted },
  });

  return c.json({ ok: true, recordsDeleted: deleted });
});

/**
 * Delete all data originating from one provider.
 *
 * Canonical workouts are only removed when the provider was their *only*
 * source — a run corroborated by two services survives disconnecting one of
 * them, with that source's contribution dropped.
 */
async function deleteProviderData(
  db: Awaited<ReturnType<typeof getDb>>['db'],
  athleteId: string,
  connectionId: string,
  provider: string,
): Promise<number> {
  let deleted = 0;

  const sources = await db
    .select()
    .from(workoutSources)
    .where(eq(workoutSources.provider, provider));

  for (const source of sources) {
    const siblings = await db
      .select()
      .from(workoutSources)
      .where(eq(workoutSources.canonicalWorkoutId, source.canonicalWorkoutId));

    await db
      .delete(workoutSources)
      .where(
        and(
          eq(workoutSources.provider, provider),
          eq(workoutSources.externalId, source.externalId),
        ),
      );

    // Last source standing: the workout has no evidence left.
    if (siblings.length <= 1) {
      await db
        .delete(canonicalWorkouts)
        .where(
          and(
            eq(canonicalWorkouts.id, source.canonicalWorkoutId),
            eq(canonicalWorkouts.athleteId, athleteId),
          ),
        );
    }
    deleted++;
  }

  if (provider === 'whoop') {
    await db.delete(whoopRecoveries).where(eq(whoopRecoveries.connectionId, connectionId));
    await db.delete(whoopSleep).where(eq(whoopSleep.connectionId, connectionId));
  }
  if (provider === 'healthkit') {
    await db.delete(healthkitSamples).where(eq(healthkitSamples.connectionId, connectionId));
  }

  await db
    .delete(bodyMeasurements)
    .where(
      and(eq(bodyMeasurements.athleteId, athleteId), eq(bodyMeasurements.provider, provider)),
    );

  await recomputeTrainingLoads(db, athleteId);
  return deleted;
}

/**
 * HealthKit ingest.
 *
 * The iOS app posts batches of samples read on-device. Idempotent on the
 * HKSample UUID, so re-sending an overlapping window is harmless.
 */
connectionRoutes.post('/healthkit/ingest', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    workouts?: unknown[];
    samples?: unknown[];
  };

  const athleteId = c.get('athleteId');
  const { db } = await getDb();

  const [profile] = await db
    .select()
    .from(athleteProfiles)
    .where(eq(athleteProfiles.id, athleteId))
    .limit(1);
  const timezone = profile?.timezone ?? 'UTC';

  const connection = await upsertConnection(db, athleteId, 'healthkit', {
    status: 'connected',
    connectedAt: new Date(),
  });

  let ingested = 0;

  for (const raw of body.workouts ?? []) {
    const workout = raw as {
      uuid?: string;
      activityType?: string;
      startDate?: string;
      endDate?: string;
      durationSeconds?: number;
      distanceMeters?: number;
      avgHeartRateBpm?: number;
      maxHeartRateBpm?: number;
      totalEnergyKcal?: number;
      isIndoor?: boolean;
      sourceName?: string;
    };
    if (!workout.uuid || !workout.startDate) continue;

    const startTime = new Date(workout.startDate);
    const endTime = workout.endDate
      ? new Date(workout.endDate)
      : new Date(startTime.getTime() + (workout.durationSeconds ?? 0) * 1000);

    await db
      .insert(healthkitSamples)
      .values({
        connectionId: connection.id,
        athleteId,
        externalId: workout.uuid,
        sampleType: 'workout',
        startDate: startTime,
        endDate: endTime,
        value: workout.distanceMeters ?? null,
        unit: 'm',
        payload: workout as object,
        sourceName: workout.sourceName ?? null,
      })
      .onConflictDoNothing();

    // Register as a canonical workout candidate; the rebuild pass merges it
    // with any Strava/WHOOP record of the same session.
    const [existing] = await db
      .select()
      .from(workoutSources)
      .where(
        and(
          eq(workoutSources.provider, 'healthkit'),
          eq(workoutSources.externalId, workout.uuid),
        ),
      )
      .limit(1);

    if (!existing) {
      const [inserted] = await db
        .insert(canonicalWorkouts)
        .values({
          athleteId,
          type: 'easy',
          sport: mapHealthKitActivity(workout.activityType),
          startTime,
          endTime,
          timezone,
          localDate: toLocalDate(startTime, timezone),
          durationSeconds: workout.durationSeconds ?? null,
          movingTimeSeconds: workout.durationSeconds ?? null,
          distanceMeters: workout.distanceMeters ?? null,
          avgHeartRateBpm: workout.avgHeartRateBpm ?? null,
          maxHeartRateBpm: workout.maxHeartRateBpm ?? null,
          calories: workout.totalEnergyKcal ?? null,
          indoor: workout.isIndoor ?? null,
          sourceConfidence: 0.6,
        })
        .returning();

      await db.insert(workoutSources).values({
        canonicalWorkoutId: inserted!.id,
        provider: 'healthkit',
        externalId: workout.uuid,
        contributedFields: [],
      });
    }
    ingested++;
  }

  for (const raw of body.samples ?? []) {
    const sample = raw as {
      uuid?: string;
      type?: string;
      startDate?: string;
      endDate?: string;
      value?: number;
      unit?: string;
      sourceName?: string;
    };
    if (!sample.uuid || !sample.startDate || !sample.type) continue;

    await db
      .insert(healthkitSamples)
      .values({
        connectionId: connection.id,
        athleteId,
        externalId: sample.uuid,
        sampleType: sample.type,
        startDate: new Date(sample.startDate),
        endDate: sample.endDate ? new Date(sample.endDate) : null,
        value: sample.value ?? null,
        unit: sample.unit ?? null,
        payload: sample as object,
        sourceName: sample.sourceName ?? null,
      })
      .onConflictDoNothing();

    // Body metrics feed the provenance-resolved profile values.
    if (sample.type === 'body_mass' && sample.value) {
      await db
        .insert(bodyMeasurements)
        .values({
          athleteId,
          metric: 'weight_kg',
          provider: 'healthkit',
          originalValue: sample.value,
          normalizedValue: sample.value,
          measuredAt: new Date(sample.startDate),
        })
        .onConflictDoNothing();
    }
    ingested++;
  }

  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const rebuild = await rebuildCanonicalWorkouts(db, athleteId, timezone, since);
  await recomputeTrainingLoads(db, athleteId);

  await db
    .update(providerConnections)
    .set({ lastSyncedAt: new Date(), status: 'connected', updatedAt: new Date() })
    .where(eq(providerConnections.id, connection.id));

  return c.json({ ingested, duplicatesMerged: rebuild.duplicatesMerged });
});

function mapHealthKitActivity(activityType: string | undefined): string {
  const type = (activityType ?? '').toLowerCase();
  if (type.includes('run')) return 'run';
  if (type.includes('walk') || type.includes('hik')) return 'walk';
  if (type.includes('cycl')) return 'ride';
  if (type.includes('swim')) return 'swim';
  if (type.includes('strength') || type.includes('training')) return 'strength';
  return 'other';
}

// ---------------------------------------------------------------------------
// OAuth callback (unauthenticated — the browser arrives here from the provider)
// ---------------------------------------------------------------------------

connectionRoutes.get('/:provider/callback', async (c) => {
  const provider = c.req.param('provider');
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    return c.html(callbackPage('Connection cancelled', 'You can close this window and try again.'));
  }
  if (!code || !state) {
    return c.html(callbackPage('Something went wrong', 'The provider did not return an authorization code.'));
  }

  const verified = verifyState(state);
  if (!verified || verified.provider !== provider) {
    logger.warn('oauth.callback.invalid_state', { provider });
    return c.html(
      callbackPage('Could not verify this request', 'Start the connection again from the app.'),
    );
  }

  if (!isConnectableProvider(provider)) return c.html(callbackPage('Unknown provider', ''));

  const implementation = getProvider(provider as ProviderId);
  if (!implementation) return c.html(callbackPage('Unknown provider', ''));

  try {
    const tokens = await implementation.exchangeCode(code);
    const { db } = await getDb();

    await upsertConnection(db, verified.athleteId, provider, {
      status: 'connected',
      connectedAt: new Date(),
      scopes: tokens.scopes,
      externalUserId: tokens.externalUserId ?? null,
      accessTokenEncrypted: encryptSecret(tokens.accessToken),
      refreshTokenEncrypted: encryptSecret(tokens.refreshToken),
      tokenExpiresAt: tokens.expiresAt ?? null,
      lastSyncError: null,
    });

    // First connect pulls history in the background so the callback returns fast.
    await enqueueSync({
      athleteId: verified.athleteId,
      provider: provider as ProviderId,
      kind: 'full',
    });

    logger.info('oauth.callback.connected', { provider });

    return c.html(
      callbackPage(
        `${implementation.displayName} connected`,
        'Your history is importing now. You can close this window and return to the app.',
      ),
    );
  } catch (err) {
    logger.error('oauth.callback.failed', { provider, error: String(err) });
    return c.html(
      callbackPage('Could not complete the connection', 'Please try again from the app.'),
    );
  }
});

async function upsertConnection(
  db: Awaited<ReturnType<typeof getDb>>['db'],
  athleteId: string,
  provider: string,
  values: Partial<typeof providerConnections.$inferInsert>,
): Promise<typeof providerConnections.$inferSelect> {
  const [row] = await db
    .insert(providerConnections)
    .values({ athleteId, provider, ...values })
    .onConflictDoUpdate({
      target: [providerConnections.athleteId, providerConnections.provider],
      set: { ...values, updatedAt: new Date() },
    })
    .returning();

  return row!;
}

/** Minimal self-contained page shown after the OAuth redirect. */
function callbackPage(title: string, body: string): string {
  const escape = (value: string): string =>
    value.replace(/[&<>"']/g, (ch) =>
      ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
    );

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         display: grid; place-items: center; min-height: 100vh; margin: 0;
         background: #0b0d10; color: #f2f4f7; }
  main { max-width: 30rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 .75rem; letter-spacing: -0.01em; }
  p { color: #9aa4b2; line-height: 1.6; margin: 0; }
</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(body)}</p></main></body></html>`;
}

/** Count of stored records per provider, for the Connections screen. */
export async function providerRecordCounts(athleteId: string) {
  const { db } = await getDb();
  const [workouts] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(canonicalWorkouts)
    .where(eq(canonicalWorkouts.athleteId, athleteId));
  return { workouts: workouts?.count ?? 0 };
}
