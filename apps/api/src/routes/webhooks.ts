/**
 * Provider webhooks.
 *
 * The shape is the same for both providers and matters more than the details:
 *
 *   receive → validate → persist the event → ACK immediately → process later
 *
 * Nothing heavy happens inside the request. Providers time out fast and
 * retry aggressively; doing a full sync inline would turn one event into a
 * retry storm. The event row is the durable record, deduplicated on a stable
 * key so a redelivery is acknowledged without being processed twice.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import { providerConnections, syncEvents } from '../db/schema.js';
import { enqueueSync } from '../sync/engine.js';
import { env } from '../env.js';
import { verifyHmacSignature } from '../security/crypto.js';
import { logger } from '../observability/logger.js';
import { webhookEventKey as stravaEventKey } from '../providers/strava/normalize.js';
import { webhookEventKey as whoopEventKey } from '../providers/whoop/normalize.js';
import type { StravaWebhookEvent } from '../providers/strava/api.js';
import type { WhoopWebhookEvent } from '../providers/whoop/api.js';

export const webhookRoutes = new Hono();

// ---------------------------------------------------------------------------
// Strava
// ---------------------------------------------------------------------------

/**
 * Subscription validation.
 *
 * Strava GETs this endpoint when a push subscription is created and expects
 * the challenge echoed back in a `hub.challenge` field.
 */
webhookRoutes.get('/strava', (c) => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');

  const expected = env().STRAVA_WEBHOOK_VERIFY_TOKEN;

  if (mode !== 'subscribe' || !challenge) {
    return c.json({ error: 'invalid verification request' }, 400);
  }
  if (!expected || token !== expected) {
    logger.warn('webhook.strava.verify_token_mismatch');
    return c.json({ error: 'invalid verify token' }, 403);
  }

  logger.info('webhook.strava.verified');
  return c.json({ 'hub.challenge': challenge });
});

webhookRoutes.post('/strava', async (c) => {
  let event: StravaWebhookEvent;
  try {
    event = (await c.req.json()) as StravaWebhookEvent;
  } catch {
    // Malformed body: acknowledge so Strava stops retrying something we can
    // never process.
    return c.json({ received: true }, 200);
  }

  if (!event?.object_type || event.object_id === undefined) {
    return c.json({ received: true }, 200);
  }

  const { db } = await getDb();
  const eventKey = stravaEventKey(event);

  const [stored] = await db
    .insert(syncEvents)
    .values({
      provider: 'strava',
      eventKey,
      externalUserId: String(event.owner_id),
      payload: event as unknown as object,
      status: 'received',
    })
    // A redelivery of an event we already have is a no-op.
    .onConflictDoNothing()
    .returning();

  // ACK before doing any work. Everything below is best-effort scheduling.
  queueMicrotask(() => {
    if (!stored) return;
    void processStravaEvent(event, stored.id).catch((error: unknown) => {
      logger.error('webhook.strava.process_failed', { error: String(error) });
    });
  });

  return c.json({ received: true }, 200);
});

async function processStravaEvent(event: StravaWebhookEvent, eventId: string): Promise<void> {
  const { db } = await getDb();

  const [connection] = await db
    .select()
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.provider, 'strava'),
        eq(providerConnections.externalUserId, String(event.owner_id)),
      ),
    )
    .limit(1);

  if (!connection) {
    await db
      .update(syncEvents)
      .set({ status: 'ignored', processedAt: new Date(), error: 'No matching connection' })
      .where(eq(syncEvents.id, eventId));
    return;
  }

  // Athlete revoked us from Strava's side.
  if (event.object_type === 'athlete' && event.updates?.authorized === 'false') {
    await db
      .update(providerConnections)
      .set({
        status: 'disconnected',
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        tokenExpiresAt: null,
        lastSyncError: 'You revoked access from Strava.',
        updatedAt: new Date(),
      })
      .where(eq(providerConnections.id, connection.id));

    logger.info('webhook.strava.deauthorized', { connectionId: connection.id });
    await db
      .update(syncEvents)
      .set({ status: 'processed', processedAt: new Date() })
      .where(eq(syncEvents.id, eventId));
    return;
  }

  if (event.object_type === 'activity') {
    // An incremental sync picks up creates and updates alike, and keeps one
    // code path rather than a bespoke single-activity ingest.
    await enqueueSync({
      athleteId: connection.athleteId,
      provider: 'strava',
      kind: 'webhook',
      payload: { objectId: event.object_id, aspect: event.aspect_type },
    });
  }

  await db
    .update(syncEvents)
    .set({ status: 'processed', processedAt: new Date() })
    .where(eq(syncEvents.id, eventId));
}

// ---------------------------------------------------------------------------
// WHOOP
// ---------------------------------------------------------------------------

/**
 * WHOOP signs webhooks with an HMAC over `timestamp + rawBody`.
 *
 * The RAW body must be used: re-serialising parsed JSON changes key order and
 * whitespace, which changes the digest and fails verification.
 */
webhookRoutes.post('/whoop', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('x-whoop-signature');
  const timestamp = c.req.header('x-whoop-signature-timestamp');
  const secret = env().WHOOP_WEBHOOK_SECRET;

  if (secret) {
    if (!signature || !timestamp) {
      logger.warn('webhook.whoop.missing_signature');
      return c.json({ error: 'missing signature' }, 401);
    }

    const valid = verifyHmacSignature({
      secret,
      payload: `${timestamp}${rawBody}`,
      signature,
      encoding: 'base64',
    });

    if (!valid) {
      logger.warn('webhook.whoop.invalid_signature');
      return c.json({ error: 'invalid signature' }, 401);
    }

    // Reject stale timestamps to blunt replay attempts.
    const age = Math.abs(Date.now() - Number(timestamp));
    if (Number.isFinite(age) && age > 5 * 60 * 1000) {
      logger.warn('webhook.whoop.stale_timestamp');
      return c.json({ error: 'stale request' }, 401);
    }
  } else {
    // Without a configured secret we cannot verify authenticity. Accept only
    // outside production, and say so loudly.
    if (env().NODE_ENV === 'production') {
      logger.error('webhook.whoop.no_secret_configured');
      return c.json({ error: 'webhook not configured' }, 503);
    }
    logger.warn('webhook.whoop.unverified_accepted_in_development');
  }

  let event: WhoopWebhookEvent;
  try {
    event = JSON.parse(rawBody) as WhoopWebhookEvent;
  } catch {
    return c.json({ received: true }, 200);
  }

  if (!event?.type || event.id === undefined) return c.json({ received: true }, 200);

  const { db } = await getDb();
  const [stored] = await db
    .insert(syncEvents)
    .values({
      provider: 'whoop',
      eventKey: whoopEventKey(event),
      externalUserId: String(event.user_id),
      payload: event as unknown as object,
      status: 'received',
    })
    .onConflictDoNothing()
    .returning();

  queueMicrotask(() => {
    if (!stored) return;
    void processWhoopEvent(event, stored.id).catch((error: unknown) => {
      logger.error('webhook.whoop.process_failed', { error: String(error) });
    });
  });

  return c.json({ received: true }, 200);
});

async function processWhoopEvent(event: WhoopWebhookEvent, eventId: string): Promise<void> {
  const { db } = await getDb();

  const [connection] = await db
    .select()
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.provider, 'whoop'),
        eq(providerConnections.externalUserId, String(event.user_id)),
      ),
    )
    .limit(1);

  if (!connection) {
    await db
      .update(syncEvents)
      .set({ status: 'ignored', processedAt: new Date(), error: 'No matching connection' })
      .where(eq(syncEvents.id, eventId));
    return;
  }

  await enqueueSync({
    athleteId: connection.athleteId,
    provider: 'whoop',
    kind: 'webhook',
    payload: { objectId: String(event.id), type: event.type },
  });

  await db
    .update(syncEvents)
    .set({ status: 'processed', processedAt: new Date() })
    .where(eq(syncEvents.id, eventId));
}
