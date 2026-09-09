/**
 * Body composition schema tests.
 *
 * Runs the real migrations against embedded Postgres, so the constraints that
 * make the module safe — one photo per side, one value per tape point,
 * cascading deletion with the athlete — are exercised rather than assumed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { CIRCUMFERENCE_POINT_CATALOG } from '@running/core';

import { loadEnv, setEnvForTesting } from '../env.js';
import { getDb, resetDbForTesting, type Database } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import {
  athleteProfiles,
  bodyCompositionSessions,
  circumferencePoints,
  compositionMeasurements,
  compositionPhotos,
  users,
} from '../db/schema.js';

const DATA_DIR = 'memory://running-os-body-composition-tests';

let db: Database;

beforeAll(async () => {
  setEnvForTesting(
    loadEnv({
      NODE_ENV: 'test',
      USE_MOCK_DATA: true,
      DATABASE_URL: '',
      PGLITE_DIR: DATA_DIR,
      AUTH_JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
      TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
    }),
  );

  resetDbForTesting();
  const handle = await getDb({ dataDir: DATA_DIR });
  db = handle.db;
  await runMigrations({ dataDir: DATA_DIR });
}, 120_000);

afterAll(async () => {
  const handle = await getDb({ dataDir: DATA_DIR });
  await handle.close();
  setEnvForTesting(undefined);
});

async function createAthlete(email: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: 'not-a-real-hash', displayName: 'Test Athlete' })
    .returning();
  const [athlete] = await db
    .insert(athleteProfiles)
    .values({ userId: user!.id, displayName: 'Test Athlete' })
    .returning();
  return athlete!.id;
}

async function pointId(code: string): Promise<string> {
  const [row] = await db
    .select()
    .from(circumferencePoints)
    .where(eq(circumferencePoints.code, code))
    .limit(1);
  if (!row) throw new Error(`missing catalog point ${code}`);
  return row.id;
}

describe('circumference point catalog', () => {
  it('is seeded from @running/core when migrations run', async () => {
    const rows = await db.select().from(circumferencePoints).orderBy(circumferencePoints.sortOrder);
    expect(rows.map((r) => r.code)).toEqual(CIRCUMFERENCE_POINT_CATALOG.map((p) => p.code));
    expect(rows.every((r) => r.guideText.length > 0)).toBe(true);
  });

  it('is idempotent across repeated migration runs', async () => {
    await runMigrations({ dataDir: DATA_DIR });
    const rows = await db.select().from(circumferencePoints);
    expect(rows).toHaveLength(CIRCUMFERENCE_POINT_CATALOG.length);
  });

  it('cannot hold two points with the same code', async () => {
    await expect(
      db.insert(circumferencePoints).values({
        code: 'waist',
        label: 'Waist again',
        guideText: 'Duplicate',
        sortOrder: 99,
      }),
    ).rejects.toThrow();
  });
});

describe('sessions, photos and measurements', () => {
  it('stores a session with its photos and measurements', async () => {
    const athleteId = await createAthlete('composition-1@example.com');
    const capturedAt = new Date('2026-09-06T06:40:00+07:00');

    const [session] = await db
      .insert(bodyCompositionSessions)
      .values({ athleteId, capturedAt, localDate: '2026-09-06', weightKilograms: 64.2 })
      .returning();

    for (const side of ['front', 'back', 'left', 'right']) {
      await db.insert(compositionPhotos).values({
        sessionId: session!.id,
        athleteId,
        side,
        storageKey: `athletes/${athleteId}/sessions/${session!.id}/${side}.jpg`,
        contentType: 'image/jpeg',
        capturedAt,
      });
    }

    await db.insert(compositionMeasurements).values({
      sessionId: session!.id,
      athleteId,
      pointId: await pointId('waist'),
      value: 30.9,
      unit: 'in',
      valueCm: 78.5,
      capturedAt,
    });

    const photos = await db
      .select()
      .from(compositionPhotos)
      .where(eq(compositionPhotos.sessionId, session!.id));
    const measurements = await db
      .select()
      .from(compositionMeasurements)
      .where(eq(compositionMeasurements.sessionId, session!.id));

    expect(photos).toHaveLength(4);
    expect(measurements).toHaveLength(1);
    // The entered value and its unit survive alongside the canonical form.
    expect(measurements[0]!.unit).toBe('in');
    expect(measurements[0]!.valueCm).toBeCloseTo(78.5, 5);
  });

  it('refuses a second photo of the same side in one session', async () => {
    const athleteId = await createAthlete('composition-2@example.com');
    const capturedAt = new Date();
    const [session] = await db
      .insert(bodyCompositionSessions)
      .values({ athleteId, capturedAt, localDate: '2026-09-07' })
      .returning();

    const photo = {
      sessionId: session!.id,
      athleteId,
      side: 'front',
      storageKey: 'front-1.jpg',
      capturedAt,
    };
    await db.insert(compositionPhotos).values(photo);
    await expect(
      db.insert(compositionPhotos).values({ ...photo, storageKey: 'front-2.jpg' }),
    ).rejects.toThrow();
  });

  it('refuses a second value for the same point in one session', async () => {
    const athleteId = await createAthlete('composition-3@example.com');
    const capturedAt = new Date();
    const [session] = await db
      .insert(bodyCompositionSessions)
      .values({ athleteId, capturedAt, localDate: '2026-09-07' })
      .returning();

    const waist = await pointId('waist');
    const measurement = {
      sessionId: session!.id,
      athleteId,
      pointId: waist,
      value: 78.6,
      unit: 'cm',
      valueCm: 78.6,
      capturedAt,
    };
    await db.insert(compositionMeasurements).values(measurement);
    await expect(
      db.insert(compositionMeasurements).values({ ...measurement, value: 79 }),
    ).rejects.toThrow();
  });

  it('removes photos and measurements with the athlete', async () => {
    const athleteId = await createAthlete('composition-4@example.com');
    const capturedAt = new Date();
    const [session] = await db
      .insert(bodyCompositionSessions)
      .values({ athleteId, capturedAt, localDate: '2026-09-07' })
      .returning();
    await db.insert(compositionPhotos).values({
      sessionId: session!.id,
      athleteId,
      side: 'left',
      storageKey: 'left.jpg',
      capturedAt,
    });
    await db.insert(compositionMeasurements).values({
      sessionId: session!.id,
      athleteId,
      pointId: await pointId('hips'),
      value: 93.2,
      unit: 'cm',
      valueCm: 93.2,
      capturedAt,
    });

    await db.delete(athleteProfiles).where(eq(athleteProfiles.id, athleteId));

    expect(
      await db
        .select()
        .from(bodyCompositionSessions)
        .where(eq(bodyCompositionSessions.athleteId, athleteId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(compositionPhotos).where(eq(compositionPhotos.athleteId, athleteId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(compositionMeasurements)
        .where(eq(compositionMeasurements.athleteId, athleteId)),
    ).toHaveLength(0);
  });

  it('keeps a catalog point that measurements still reference', async () => {
    const athleteId = await createAthlete('composition-5@example.com');
    const capturedAt = new Date();
    const [session] = await db
      .insert(bodyCompositionSessions)
      .values({ athleteId, capturedAt, localDate: '2026-09-07' })
      .returning();
    const chest = await pointId('chest');
    await db.insert(compositionMeasurements).values({
      sessionId: session!.id,
      athleteId,
      pointId: chest,
      value: 97.2,
      unit: 'cm',
      valueCm: 97.2,
      capturedAt,
    });

    await expect(
      db.delete(circumferencePoints).where(eq(circumferencePoints.id, chest)),
    ).rejects.toThrow();
  });
});
