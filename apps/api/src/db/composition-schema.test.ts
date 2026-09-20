/**
 * Body composition schema constraints.
 *
 * Runs the real migrations against embedded Postgres, because the rules being
 * checked here are database rules. A test that asserted them in application
 * code would pass while the column that enforces them was missing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { loadEnv, setEnvForTesting } from '../env.js';
import { getDb, resetDbForTesting, type Database } from './client.js';
import { runMigrations } from './migrate.js';
import { athleteProfiles, bodyCompositionSessions, compositionPhotos, users } from './schema.js';

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
