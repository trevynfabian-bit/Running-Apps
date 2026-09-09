/**
 * Tape measurement endpoint tests.
 *
 * Real migrations, real auth, real formulas: saving readings must change the
 * estimates the session reports, and correcting a reading must change them
 * again rather than leave a stale value behind.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { bodyCompositionSessionSchema } from '@running/contracts';

import { loadEnv, setEnvForTesting } from '../env.js';
import { getDb, resetDbForTesting, type Database } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { resetProviderRegistry } from '../providers/registry.js';
import { athleteProfiles, bodyMeasurements } from '../db/schema.js';

const DATA_DIR = 'memory://running-os-body-composition-measurement-tests';

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

async function authed(path: string, init: RequestInit = {}, bearer = token): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bearer}`,
      ...(init.headers ?? {}),
    },
  });
}

async function createSession(body: Record<string, unknown>): Promise<string> {
  const response = await authed('/api/body-composition/sessions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return (await json(response)).id as string;
}

async function save(
  sessionId: string,
  body: Record<string, unknown>,
  bearer = token,
): Promise<Response> {
  return authed(
    `/api/body-composition/sessions/${sessionId}/measurements`,
    { method: 'PUT', body: JSON.stringify(body) },
    bearer,
  );
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

  const signedUp = await signUp('tape-input@example.com');
  token = signedUp.token;
  athleteId = signedUp.athleteId;

  // A male athlete with a known height, so the Navy formula can run.
  await db.update(athleteProfiles).set({ sex: 'male' }).where(eq(athleteProfiles.id, athleteId));
  await db.insert(bodyMeasurements).values({
    athleteId,
    metric: 'height_m',
    provider: 'manual',
    originalValue: 1.78,
    normalizedValue: 1.78,
    measuredAt: new Date('2026-06-01T07:00:00Z'),
  });
}, 120_000);

afterAll(async () => {
  const handle = await getDb({ dataDir: DATA_DIR });
  await handle.close();
  setEnvForTesting(undefined);
});

describe('PUT /api/body-composition/sessions/:id/measurements', () => {
  let sessionId: string;

  beforeAll(async () => {
    sessionId = await createSession({ capturedAt: '2026-09-06T06:40:00Z', weightKilograms: 75 });
  });

  it('stores readings as entered, with the canonical centimetre value beside them', async () => {
    const response = await save(sessionId, {
      measurements: [
        { pointCode: 'waist', value: 33.5, unit: 'in' },
        { pointCode: 'neck', value: 38, unit: 'cm' },
      ],
    });
    expect(response.status).toBe(200);
    const session = bodyCompositionSessionSchema.parse(await json(response));

    expect(session.id).toBe(sessionId);
    // Catalog order, not entry order.
    expect(session.measurements.map((m) => m.pointCode)).toEqual(['neck', 'waist']);
    const waist = session.measurements[1]!;
    expect(waist).toMatchObject({ pointLabel: 'Waist', value: 33.5, unit: 'in' });
    expect(waist.valueCm).toBeCloseTo(85.09, 2);
    // Tape time defaults to the session's capture time.
    expect(waist.capturedAt).toBe('2026-09-06T06:40:00.000Z');
  });

  it('recomputes the estimates from the new readings', async () => {
    const session = bodyCompositionSessionSchema.parse(
      await json(await authed(`/api/body-composition/sessions/${sessionId}`)),
    );
    // Height (logged), neck and waist (tape) and weight (session): both formulas run.
    expect(session.estimates.map((e) => e.formula)).toEqual(['us_navy', 'ymca']);
    expect(session.estimateRequirements).toEqual([]);
    const navy = session.estimates[0]!;
    expect(navy.inputs.find((i) => i.key === 'waist')?.value).toBeCloseTo(85.1, 1);
    expect(navy.valueLow).toBeLessThan(navy.valueHigh);
  });

  it('corrects a reading in place instead of adding a second one', async () => {
    const before = bodyCompositionSessionSchema.parse(
      await json(await authed(`/api/body-composition/sessions/${sessionId}`)),
    );
    const navyBefore = before.estimates.find((e) => e.formula === 'us_navy')!;

    const response = await save(sessionId, {
      measurements: [{ pointCode: 'waist', value: 90, unit: 'cm' }],
      capturedAt: '2026-09-06T06:50:00Z',
    });
    expect(response.status).toBe(200);
    const after = bodyCompositionSessionSchema.parse(await json(response));

    expect(after.measurements).toHaveLength(2);
    const waist = after.measurements.find((m) => m.pointCode === 'waist')!;
    expect(waist.id).toBe(before.measurements.find((m) => m.pointCode === 'waist')!.id);
    expect(waist).toMatchObject({ value: 90, unit: 'cm', valueCm: 90 });
    expect(waist.capturedAt).toBe('2026-09-06T06:50:00.000Z');

    // A bigger waist reads as more body fat; the estimate followed the correction.
    const navyAfter = after.estimates.find((e) => e.formula === 'us_navy')!;
    expect(navyAfter.value).toBeGreaterThan(navyBefore.value);
  });

  it('rejects unknown points, duplicates and values no tape could read', async () => {
    const unknown = await save(sessionId, {
      measurements: [{ pointCode: 'elbow', value: 30, unit: 'cm' }],
    });
    expect(unknown.status).toBe(400);
    expect((await json(unknown)).error.message).toMatch(/Unknown measurement point/);

    const duplicate = await save(sessionId, {
      measurements: [
        { pointCode: 'hips', value: 96, unit: 'cm' },
        { pointCode: 'hips', value: 97, unit: 'cm' },
      ],
    });
    expect(duplicate.status).toBe(400);
    expect((await json(duplicate)).error.message).toMatch(/more than once/);

    // 96 inches is a typo for 96 cm; the message says to check the unit.
    const absurd = await save(sessionId, {
      measurements: [{ pointCode: 'hips', value: 300, unit: 'in' }],
    });
    expect(absurd.status).toBe(400);
    expect((await json(absurd)).error.message).toMatch(/Check the value and the unit/);

    const malformed = await save(sessionId, { measurements: [] });
    expect(malformed.status).toBe(400);
    expect((await json(malformed)).error.code).toBe('validation_failed');

    const negative = await save(sessionId, {
      measurements: [{ pointCode: 'hips', value: -5, unit: 'cm' }],
    });
    expect(negative.status).toBe(400);

    // Nothing from the rejected batches was written.
    const session = bodyCompositionSessionSchema.parse(
      await json(await authed(`/api/body-composition/sessions/${sessionId}`)),
    );
    expect(session.measurements.map((m) => m.pointCode)).toEqual(['neck', 'waist']);
  });

  it('writes nothing when one reading in a batch is invalid', async () => {
    const response = await save(sessionId, {
      measurements: [
        { pointCode: 'chest', value: 97, unit: 'cm' },
        { pointCode: 'ankle', value: 22, unit: 'cm' },
      ],
    });
    expect(response.status).toBe(400);
    const session = bodyCompositionSessionSchema.parse(
      await json(await authed(`/api/body-composition/sessions/${sessionId}`)),
    );
    expect(session.measurements.some((m) => m.pointCode === 'chest')).toBe(false);
  });

  it("hides other athletes' sessions", async () => {
    const other = await signUp('other-tape-input@example.com');
    const response = await save(
      sessionId,
      { measurements: [{ pointCode: 'waist', value: 80, unit: 'cm' }] },
      other.token,
    );
    expect(response.status).toBe(404);

    const missing = await save(randomUUID(), {
      measurements: [{ pointCode: 'waist', value: 80, unit: 'cm' }],
    });
    expect(missing.status).toBe(404);
  });
});

describe('DELETE /api/body-composition/sessions/:id/measurements/:pointCode', () => {
  it('removes one reading and the estimates that depended on it', async () => {
    const sessionId = await createSession({
      capturedAt: '2026-09-07T06:40:00Z',
      weightKilograms: 75,
    });
    await save(sessionId, {
      measurements: [
        { pointCode: 'neck', value: 38, unit: 'cm' },
        { pointCode: 'waist', value: 85, unit: 'cm' },
      ],
    });

    const response = await authed(`/api/body-composition/sessions/${sessionId}/measurements/neck`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    const session = bodyCompositionSessionSchema.parse(await json(response));
    expect(session.measurements.map((m) => m.pointCode)).toEqual(['waist']);
    // Without a neck the Navy formula cannot run and says so.
    expect(session.estimates.map((e) => e.formula)).toEqual(['ymca']);
    expect(session.estimateRequirements).toEqual([{ formula: 'us_navy', missing: ['Neck'] }]);

    // Deleting again is harmless.
    const again = await authed(`/api/body-composition/sessions/${sessionId}/measurements/neck`, {
      method: 'DELETE',
    });
    expect(again.status).toBe(200);

    const unknown = await authed(`/api/body-composition/sessions/${sessionId}/measurements/elbow`, {
      method: 'DELETE',
    });
    expect(unknown.status).toBe(400);

    const other = await signUp('other-tape-delete@example.com');
    const foreign = await authed(
      `/api/body-composition/sessions/${sessionId}/measurements/waist`,
      { method: 'DELETE' },
      other.token,
    );
    expect(foreign.status).toBe(404);
  });
});
