/**
 * Body composition schema constraints.
 *
 * Runs the real migrations against embedded Postgres, because the rules being
 * checked here are database rules. A test that asserted them in application
 * code would pass while the column that enforces them was missing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';

import { loadEnv, setEnvForTesting } from '../env.js';
import { getDb, resetDbForTesting, type Database } from './client.js';
import { runMigrations } from './migrate.js';
import {
  athleteProfiles,
  bodyCompositionSessions,
  circumferencePoints,
  compositionMeasurements,
  compositionPhotos,
  users,
} from './schema.js';

const DATA_DIR = 'memory://running-os-composition-schema';

let db: Database;
let athleteId: string;
let userId: string;

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
  const handle = await getDb({ dataDir: DATA_DIR });
  await runMigrations({ dataDir: DATA_DIR });
  db = handle.db;

  const [user] = await db
    .insert(users)
    .values({
      email: 'composition@example.test',
      passwordHash: 'not-a-real-hash',
      displayName: 'Composition Tester',
    })
    .returning();
  userId = user!.id;

  const [profile] = await db
    .insert(athleteProfiles)
    .values({ userId, displayName: 'Composition Tester' })
    .returning();
  athleteId = profile!.id;
}, 120_000);

afterAll(async () => {
  const handle = await getDb({ dataDir: DATA_DIR });
  await handle.close();
  setEnvForTesting(undefined);
});

async function createSession(capturedAt: string, localDate: string): Promise<string> {
  const [session] = await db
    .insert(bodyCompositionSessions)
    .values({ athleteId, capturedAt: new Date(capturedAt), localDate })
    .returning();
  return session!.id;
}

function photo(sessionId: string, side: string, storageKey: string) {
  return {
    sessionId,
    side,
    storageKey,
    contentType: 'image/jpeg',
    byteSize: 1024,
    capturedAt: new Date('2026-09-06T07:45:00.000Z'),
  };
}

describe('body_composition_sessions', () => {
  it('records the instant and the athlete-local calendar day separately', async () => {
    const id = await createSession('2026-09-06T23:30:00.000Z', '2026-09-07');

    const [row] = await db
      .select()
      .from(bodyCompositionSessions)
      .where(eq(bodyCompositionSessions.id, id));

    // Late evening in a timezone ahead of UTC: the instant and the local day
    // genuinely disagree, which is exactly why both are stored.
    expect(row!.capturedAt.toISOString()).toBe('2026-09-06T23:30:00.000Z');
    expect(row!.localDate).toBe('2026-09-07');
  });

  it('allows two sessions on the same day', async () => {
    // A bad set of photos in the morning and a proper retake that evening is
    // two sessions. The database does not argue with the athlete about it.
    await createSession('2026-08-09T07:00:00.000Z', '2026-08-09');
    await expect(createSession('2026-08-09T19:00:00.000Z', '2026-08-09')).resolves.toBeTruthy();
  });
});

describe('composition_photos', () => {
  it('holds one photo per side per session', async () => {
    const sessionId = await createSession('2026-07-12T07:15:00.000Z', '2026-07-12');

    for (const side of ['front', 'back', 'left', 'right']) {
      await db.insert(compositionPhotos).values(photo(sessionId, side, `${sessionId}/${side}`));
    }

    const rows = await db
      .select()
      .from(compositionPhotos)
      .where(eq(compositionPhotos.sessionId, sessionId));

    expect(rows).toHaveLength(4);
  });

  it('refuses a second photo for a side already taken', async () => {
    const sessionId = await createSession('2026-07-13T07:15:00.000Z', '2026-07-13');
    await db.insert(compositionPhotos).values(photo(sessionId, 'front', `${sessionId}/front-a`));

    // Retaking a side must replace, not accumulate. Two fronts would leave the
    // before/after comparison guessing which one the athlete meant.
    await expect(
      db.insert(compositionPhotos).values(photo(sessionId, 'front', `${sessionId}/front-b`)),
    ).rejects.toThrow();
  });

  it('lets the same side exist in different sessions', async () => {
    const june = await createSession('2026-06-14T07:30:00.000Z', '2026-06-14');
    const july = await createSession('2026-07-14T07:30:00.000Z', '2026-07-14');

    await db.insert(compositionPhotos).values(photo(june, 'front', `${june}/front`));
    await expect(
      db.insert(compositionPhotos).values(photo(july, 'front', `${july}/front`)),
    ).resolves.toBeTruthy();
  });

  it('refuses two rows claiming the same storage object', async () => {
    const a = await createSession('2026-05-10T07:30:00.000Z', '2026-05-10');
    const b = await createSession('2026-05-11T07:30:00.000Z', '2026-05-11');

    await db.insert(compositionPhotos).values(photo(a, 'left', 'shared/storage/key'));

    // Deleting a storage object finds its row by key, so the key has to be
    // unique or a delete could orphan the wrong file.
    await expect(
      db.insert(compositionPhotos).values(photo(b, 'left', 'shared/storage/key')),
    ).rejects.toThrow();
  });

  it('cannot hang off a session that does not exist', async () => {
    await expect(
      db
        .insert(compositionPhotos)
        .values(photo('00000000-0000-0000-0000-000000000000', 'back', 'orphan/key')),
    ).rejects.toThrow();
  });
});

describe('deletion', () => {
  it('takes a session photos with it', async () => {
    const sessionId = await createSession('2026-04-05T07:30:00.000Z', '2026-04-05');
    await db.insert(compositionPhotos).values(photo(sessionId, 'front', `${sessionId}/front`));
    await db.insert(compositionPhotos).values(photo(sessionId, 'back', `${sessionId}/back`));

    await db.delete(bodyCompositionSessions).where(eq(bodyCompositionSessions.id, sessionId));

    const rows = await db
      .select()
      .from(compositionPhotos)
      .where(eq(compositionPhotos.sessionId, sessionId));

    // The cascade is the whole privacy story: one statement, no cleanup code
    // that might not run.
    expect(rows).toEqual([]);
  });

  it('takes every session and photo with the athlete', async () => {
    const [user] = await db
      .insert(users)
      .values({
        email: 'departing@example.test',
        passwordHash: 'not-a-real-hash',
        displayName: 'Departing Athlete',
      })
      .returning();

    const [profile] = await db
      .insert(athleteProfiles)
      .values({ userId: user!.id, displayName: 'Departing Athlete' })
      .returning();

    const [session] = await db
      .insert(bodyCompositionSessions)
      .values({
        athleteId: profile!.id,
        capturedAt: new Date('2026-03-01T07:30:00.000Z'),
        localDate: '2026-03-01',
      })
      .returning();

    await db.insert(compositionPhotos).values(photo(session!.id, 'right', `${session!.id}/right`));

    // Deleting the account is the athlete-facing action; everything composition
    // follows from it without a separate sweep.
    await db.delete(users).where(eq(users.id, user!.id));

    expect(
      await db
        .select()
        .from(bodyCompositionSessions)
        .where(eq(bodyCompositionSessions.id, session!.id)),
    ).toEqual([]);
    expect(
      await db.select().from(compositionPhotos).where(eq(compositionPhotos.sessionId, session!.id)),
    ).toEqual([]);
  });
});

describe('circumference_points', () => {
  it('is seeded by migration, in the order the athlete works down their body', async () => {
    const rows = await db
      .select()
      .from(circumferencePoints)
      .orderBy(asc(circumferencePoints.sortOrder));

    // The table means nothing without these, so a fresh database ships them.
    expect(rows.map((row) => row.code)).toEqual([
      'neck',
      'chest',
      'waist',
      'hips',
      'left_arm',
      'right_arm',
      'thigh',
    ]);
    expect(rows.every((row) => row.guideText.length > 0)).toBe(true);
    expect(rows.every((row) => row.isActive)).toBe(true);
  });

  it('refuses a duplicate code', async () => {
    await expect(
      db.insert(circumferencePoints).values({
        code: 'waist',
        label: 'Waist again',
        guideText: 'Somewhere else entirely.',
        sortOrder: 99,
      }),
    ).rejects.toThrow();
  });
});

describe('composition_measurements', () => {
  async function waistPointId(): Promise<string> {
    const [point] = await db
      .select()
      .from(circumferencePoints)
      .where(eq(circumferencePoints.code, 'waist'));
    return point!.id;
  }

  async function chestPointId(): Promise<string> {
    const [point] = await db
      .select()
      .from(circumferencePoints)
      .where(eq(circumferencePoints.code, 'chest'));
    return point!.id;
  }

  it('stores the canonical value and the unit it was read in', async () => {
    const sessionId = await createSession('2026-02-01T07:30:00.000Z', '2026-02-01');
    const pointId = await waistPointId();

    await db.insert(compositionMeasurements).values({
      sessionId,
      pointId,
      valueCm: 86.36,
      recordedUnit: 'in',
      capturedAt: new Date('2026-02-01T07:30:00.000Z'),
    });

    const [row] = await db
      .select()
      .from(compositionMeasurements)
      .where(eq(compositionMeasurements.sessionId, sessionId));

    // Both facts are kept: what it is, and what the athlete actually read.
    expect(row!.valueCm).toBeCloseTo(86.36, 10);
    expect(row!.recordedUnit).toBe('in');
  });

  it('defaults to centimetres when no unit is given', async () => {
    const sessionId = await createSession('2026-02-02T07:30:00.000Z', '2026-02-02');

    await db.insert(compositionMeasurements).values({
      sessionId,
      pointId: await waistPointId(),
      valueCm: 85.1,
      capturedAt: new Date('2026-02-02T07:30:00.000Z'),
    });

    const [row] = await db
      .select()
      .from(compositionMeasurements)
      .where(eq(compositionMeasurements.sessionId, sessionId));

    expect(row!.recordedUnit).toBe('cm');
  });

  it('holds at most one value per point per session', async () => {
    const sessionId = await createSession('2026-02-03T07:30:00.000Z', '2026-02-03');
    const pointId = await waistPointId();
    const capturedAt = new Date('2026-02-03T07:30:00.000Z');

    await db
      .insert(compositionMeasurements)
      .values({ sessionId, pointId, valueCm: 86.4, capturedAt });

    // Re-measuring replaces; two waist values would leave the comparison view
    // and the body-fat formula guessing which one the athlete meant.
    await expect(
      db.insert(compositionMeasurements).values({ sessionId, pointId, valueCm: 85.1, capturedAt }),
    ).rejects.toThrow();
  });

  it('allows different points in the same session', async () => {
    const sessionId = await createSession('2026-02-04T07:30:00.000Z', '2026-02-04');
    const capturedAt = new Date('2026-02-04T07:30:00.000Z');

    await db
      .insert(compositionMeasurements)
      .values({ sessionId, pointId: await waistPointId(), valueCm: 86.4, capturedAt });

    await expect(
      db
        .insert(compositionMeasurements)
        .values({ sessionId, pointId: await chestPointId(), valueCm: 99.2, capturedAt }),
    ).resolves.toBeTruthy();
  });

  it('allows the same point across different sessions', async () => {
    const june = await createSession('2026-02-05T07:30:00.000Z', '2026-02-05');
    const july = await createSession('2026-03-05T07:30:00.000Z', '2026-03-05');
    const pointId = await waistPointId();

    await db.insert(compositionMeasurements).values({
      sessionId: june,
      pointId,
      valueCm: 86.4,
      capturedAt: new Date('2026-02-05T07:30:00.000Z'),
    });

    await expect(
      db.insert(compositionMeasurements).values({
        sessionId: july,
        pointId,
        valueCm: 85.1,
        capturedAt: new Date('2026-03-05T07:30:00.000Z'),
      }),
    ).resolves.toBeTruthy();
  });

  it('refuses to retire a measure point that has measurements', async () => {
    const sessionId = await createSession('2026-02-06T07:30:00.000Z', '2026-02-06');
    const pointId = await waistPointId();

    await db.insert(compositionMeasurements).values({
      sessionId,
      pointId,
      valueCm: 86.4,
      capturedAt: new Date('2026-02-06T07:30:00.000Z'),
    });

    // Restrict, not cascade: removing a point must never silently delete the
    // history an athlete recorded against it.
    await expect(
      db.delete(circumferencePoints).where(eq(circumferencePoints.id, pointId)),
    ).rejects.toThrow();
  });

  it('goes with the session when the session is deleted', async () => {
    const sessionId = await createSession('2026-02-07T07:30:00.000Z', '2026-02-07');

    await db.insert(compositionMeasurements).values({
      sessionId,
      pointId: await waistPointId(),
      valueCm: 86.4,
      capturedAt: new Date('2026-02-07T07:30:00.000Z'),
    });

    await db.delete(bodyCompositionSessions).where(eq(bodyCompositionSessions.id, sessionId));

    expect(
      await db
        .select()
        .from(compositionMeasurements)
        .where(eq(compositionMeasurements.sessionId, sessionId)),
    ).toEqual([]);
  });
});
