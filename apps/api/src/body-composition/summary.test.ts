/**
 * Body composition summary endpoint tests.
 *
 * Real migrations against embedded Postgres, real auth, real formulas. The
 * sessions are inserted directly because the write endpoints arrive in later
 * tasks; what is under test is that the summary reads them back correctly and
 * only ever for the athlete who owns them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { bodyCompositionSummarySchema } from '@running/contracts';

import { loadEnv, setEnvForTesting } from '../env.js';
import { getDb, resetDbForTesting, type Database } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { resetProviderRegistry } from '../providers/registry.js';
import {
  athleteProfiles,
  bodyCompositionSessions,
  bodyMeasurements,
  circumferencePoints,
  compositionMeasurements,
  compositionPhotos,
} from '../db/schema.js';
import { SUMMARY_SESSION_LIMIT } from './sessions.js';

const DATA_DIR = 'memory://running-os-body-composition-summary-tests';

let app: Hono;
let db: Database;
let token: string;
let athleteId: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(response: Response): Promise<any> {
  return response.json();
}

async function signUp(email: string): Promise<{ token: string; athleteId: string }> {
  const response = await app.request('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'a-sufficiently-long-password', displayName: 'Tape' }),
  });
  expect(response.status).toBe(200);
  const bearer = (await json(response)).token as string;
  const me = await app.request('/api/me', { headers: { authorization: `Bearer ${bearer}` } });
  return { token: bearer, athleteId: (await json(me)).id as string };
}

async function summary(bearer = token): Promise<Response> {
  return app.request('/api/body-composition/summary', {
    headers: { authorization: `Bearer ${bearer}` },
  });
}

beforeAll(async () => {
  setEnvForTesting(
    loadEnv({
      NODE_ENV: 'test',
      USE_MOCK_DATA: true,
      DATABASE_URL: '',
      PGLITE_DIR: DATA_DIR,
      AUTH_JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
      TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
      AI_API_KEY: '',
    }),
  );

  resetDbForTesting();
  resetProviderRegistry();

  const handle = await getDb({ dataDir: DATA_DIR });
  db = handle.db;
  await runMigrations({ dataDir: DATA_DIR });

  const { createApp } = await import('../app.js');
  app = createApp();

  const signedUp = await signUp('tape@example.com');
  token = signedUp.token;
  athleteId = signedUp.athleteId;
}, 120_000);

afterAll(async () => {
  const handle = await getDb({ dataDir: DATA_DIR });
  await handle.close();
  setEnvForTesting(undefined);
});

async function pointId(code: string): Promise<string> {
  const [row] = await db
    .select()
    .from(circumferencePoints)
    .where(eq(circumferencePoints.code, code))
    .limit(1);
  if (!row) throw new Error(`missing catalog point ${code}`);
  return row.id;
}

async function createSession(input: {
  capturedAt: string;
  weightKilograms?: number;
  photos?: string[];
  cm?: Record<string, number>;
}): Promise<string> {
  const capturedAt = new Date(input.capturedAt);
  const [session] = await db
    .insert(bodyCompositionSessions)
    .values({
      athleteId,
      capturedAt,
      localDate: input.capturedAt.slice(0, 10),
      weightKilograms: input.weightKilograms,
    })
    .returning();
  for (const side of input.photos ?? []) {
    await db.insert(compositionPhotos).values({
      sessionId: session!.id,
      athleteId,
      side,
      storageKey: `${session!.id}/${side}.jpg`,
      contentType: 'image/jpeg',
      capturedAt,
    });
  }
  for (const [code, valueCm] of Object.entries(input.cm ?? {})) {
    await db.insert(compositionMeasurements).values({
      sessionId: session!.id,
      athleteId,
      pointId: await pointId(code),
      value: valueCm,
      unit: 'cm',
      valueCm,
      capturedAt,
    });
  }
  return session!.id;
}

describe('GET /api/body-composition/summary', () => {
  it('requires authentication', async () => {
    const response = await app.request('/api/body-composition/summary');
    expect(response.status).toBe(401);
  });

  it('starts empty but ready: catalog, default unit, no sessions', async () => {
    const response = await summary();
    expect(response.status).toBe(200);
    const body = bodyCompositionSummarySchema.parse(await json(response));

    expect(body.defaultUnit).toBe('cm');
    expect(body.points.map((p) => p.code)).toEqual([
      'neck',
      'chest',
      'waist',
      'hips',
      'left_arm',
      'right_arm',
      'left_thigh',
      'right_thigh',
    ]);
    expect(body.points.every((p) => p.guideText.length > 0)).toBe(true);
    expect(body.latest).toBeUndefined();
    expect(body.sessions).toEqual([]);
    expect(body.sessionCount).toBe(0);
    expect(body.note).toMatch(/not a medical/);
  });

  it('describes the latest session: photos in order, labelled tape readings, estimates', async () => {
    // Height and a logged weight from elsewhere in the app (a scale sync,
    // say). Height serves every session; the weight only sessions near it.
    await db.insert(bodyMeasurements).values([
      {
        athleteId,
        metric: 'height_m',
        provider: 'manual',
        originalValue: 1.78,
        normalizedValue: 1.78,
        measuredAt: new Date('2026-06-01T07:00:00Z'),
      },
      {
        athleteId,
        metric: 'weight_kg',
        provider: 'manual',
        originalValue: 80,
        normalizedValue: 80,
        measuredAt: new Date('2026-09-01T07:00:00Z'),
      },
    ]);

    // Older session: waist only, no weight of its own.
    const older = await createSession({
      capturedAt: '2026-08-25T06:40:00Z',
      photos: ['front'],
      cm: { waist: 86 },
    });
    // Newer session: full tape and its own weight, photos inserted out of order.
    const newer = await createSession({
      capturedAt: '2026-09-06T06:40:00Z',
      weightKilograms: 75,
      photos: ['right', 'left', 'back', 'front'],
      cm: { hips: 96, waist: 85, neck: 38 },
    });

    const body = bodyCompositionSummarySchema.parse(await json(await summary()));

    expect(body.sessionCount).toBe(2);
    expect(body.sessions.map((s) => s.id)).toEqual([newer, older]);
    expect(body.latest?.id).toBe(newer);

    const latest = body.latest!;
    expect(latest.localDate).toBe('2026-09-06');
    expect(latest.weightKilograms).toBe(75);
    expect(latest.photos.map((p) => p.side)).toEqual(['front', 'back', 'left', 'right']);
    expect(latest.measurements.map((m) => m.pointCode)).toEqual(['neck', 'waist', 'hips']);
    expect(latest.measurements[1]).toMatchObject({
      pointLabel: 'Waist',
      value: 85,
      unit: 'cm',
      valueCm: 85,
    });

    // Both formulas ran: the Navy estimate leads, and every estimate is a
    // range with reasons and working, never a bare number.
    expect(latest.estimates.map((e) => e.formula)).toEqual(['us_navy', 'ymca']);
    expect(latest.estimateRequirements).toEqual([]);
    for (const estimate of latest.estimates) {
      expect(estimate.method).toBe('formula');
      expect(estimate.valueLow).toBeLessThan(estimate.value);
      expect(estimate.valueHigh).toBeGreaterThan(estimate.value);
      expect(estimate.confidenceReasons.length).toBeGreaterThan(0);
      expect(estimate.steps.length).toBeGreaterThan(0);
      expect(estimate.note).toMatch(/not a medical/);
    }
    // The session's own weight wins over the logged one.
    const ymca = latest.estimates.find((e) => e.formula === 'ymca')!;
    expect(ymca.inputs.find((i) => i.key === 'weight')?.value).toBe(75);

    // The older session lacks a neck reading, so the Navy formula says what
    // it needs; the YMCA formula borrows the weight logged a week later.
    const previous = body.sessions[1]!;
    expect(previous.estimates.map((e) => e.formula)).toEqual(['ymca']);
    expect(previous.estimateRequirements).toEqual([{ formula: 'us_navy', missing: ['Neck'] }]);
    expect(previous.estimates[0]!.inputs.find((i) => i.key === 'weight')?.value).toBe(80);
  });

  it("follows the athlete's unit preference for the default tape unit", async () => {
    await db
      .update(athleteProfiles)
      .set({ units: 'imperial' })
      .where(eq(athleteProfiles.id, athleteId));
    const body = bodyCompositionSummarySchema.parse(await json(await summary()));
    expect(body.defaultUnit).toBe('in');
    await db
      .update(athleteProfiles)
      .set({ units: 'metric' })
      .where(eq(athleteProfiles.id, athleteId));
  });

  it('caps the sessions it returns but still reports the total', async () => {
    for (let i = 0; i < SUMMARY_SESSION_LIMIT + 1; i++) {
      await createSession({ capturedAt: `2026-07-${String(i + 1).padStart(2, '0')}T06:00:00Z` });
    }
    const body = bodyCompositionSummarySchema.parse(await json(await summary()));
    expect(body.sessions).toHaveLength(SUMMARY_SESSION_LIMIT);
    expect(body.sessionCount).toBe(2 + SUMMARY_SESSION_LIMIT + 1);
    // Still newest first, and the latest is unchanged by older inserts.
    expect(body.latest?.localDate).toBe('2026-09-06');
  });

  it("never shows another athlete's sessions", async () => {
    const other = await signUp('other-tape@example.com');
    const body = bodyCompositionSummarySchema.parse(await json(await summary(other.token)));
    expect(body.sessions).toEqual([]);
    expect(body.sessionCount).toBe(0);
    expect(body.latest).toBeUndefined();
  });
});
