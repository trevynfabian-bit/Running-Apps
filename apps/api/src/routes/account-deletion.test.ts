/**
 * Deleting an account.
 *
 * Rows leave by cascade, which the database guarantees. Photographs are files
 * on a disk and the database holds only their keys, so once the account row is
 * gone nothing can say which files were whose. These tests are mostly about
 * that asymmetry: that the images actually leave, that they leave before the
 * row that names them, and that another athlete's photos are not caught up in
 * it.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { desc, eq } from 'drizzle-orm';
import type { Hono } from 'hono';

import { loadEnv, setEnvForTesting } from '../env.js';
import { getDb, resetDbForTesting, type Database } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { resetProviderRegistry } from '../providers/registry.js';
import {
  athleteProfiles,
  auditLogs,
  bodyCompositionSessions,
  bodyFatEstimates,
  compositionMeasurements,
  compositionPhotos,
  users,
} from '../db/schema.js';
import { photoStorage, resetPhotoStorageForTesting } from '../services/photo-storage.js';

const DATA_DIR = 'memory://running-os-account-deletion';
const PASSWORD = 'a-long-enough-password';

let app: Hono;
let db: Database;
let photoRoot: string;
let accountCounter = 0;

const jpeg = (): Blob =>
  new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])], {
    type: 'image/jpeg',
  });

beforeAll(async () => {
  photoRoot = await mkdtemp(path.join(tmpdir(), 'running-os-account-'));

  setEnvForTesting(
    loadEnv({
      NODE_ENV: 'test',
      USE_MOCK_DATA: true,
      DATABASE_URL: '',
      PGLITE_DIR: DATA_DIR,
      AUTH_JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
      TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
      AI_API_KEY: '',
      PHOTO_STORAGE_DIR: photoRoot,
    }),
  );

  resetDbForTesting();
  resetProviderRegistry();
  resetPhotoStorageForTesting();

  const handle = await getDb({ dataDir: DATA_DIR });
  await runMigrations({ dataDir: DATA_DIR });
  db = handle.db;

  const { createApp } = await import('../app.js');
  app = createApp();
}, 120_000);

afterAll(async () => {
  const handle = await getDb({ dataDir: DATA_DIR });
  await handle.close();
  await rm(photoRoot, { recursive: true, force: true });
  setEnvForTesting(undefined);
  resetPhotoStorageForTesting();
});

interface Account {
  token: string;
  userId: string;
  athleteId: string;
  sessionId: string;
  storageKeys: string[];
}

/** An account with one furnished composition session. */
async function account(): Promise<Account> {
  const email = `deletion-${(accountCounter += 1)}@example.test`;

  const signUp = await app.request('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName: 'Deletion Tester' }),
  });
  const { token, user } = (await signUp.json()) as { token: string; user: { id: string } };

  const form = new FormData();
  for (const side of ['front', 'back', 'left', 'right']) form.append(side, jpeg(), `${side}.jpg`);

  const created = (await (
    await app.request('/api/composition/sessions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    })
  ).json()) as { id: string };

  await app.request(`/api/composition/sessions/${created.id}/measurements`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      measurements: [
        { pointCode: 'waist', value: 86.4 },
        { pointCode: 'neck', value: 38.1 },
      ],
    }),
  });

  await app.request(`/api/composition/sessions/${created.id}/body-fat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'navy', variant: 'male', height: { value: 178, unit: 'cm' } }),
  });

  const [profile] = await db
    .select()
    .from(athleteProfiles)
    .where(eq(athleteProfiles.userId, user.id))
    .limit(1);

  const photos = await db
    .select()
    .from(compositionPhotos)
    .where(eq(compositionPhotos.sessionId, created.id));

  return {
    token,
    userId: user.id,
    athleteId: profile!.id,
    sessionId: created.id,
    storageKeys: photos.map((photo) => photo.storageKey),
  };
}

const destroy = async (
  token: string,
  body: unknown = { password: PASSWORD, confirm: 'DELETE' },
): Promise<Response> =>
  app.request('/api/me', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('DELETE /api/me', () => {
  it('requires a signed-in athlete', async () => {
    const response = await app.request('/api/me', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD, confirm: 'DELETE' }),
    });
    expect(response.status).toBe(401);
  });

  it('refuses a wrong password and changes nothing', async () => {
    const mine = await account();

    const response = await destroy(mine.token, { password: 'not-my-password', confirm: 'DELETE' });
    expect(response.status).toBe(401);

    // A token copied off a device should be enough to read an athlete's
    // training and not enough to erase it.
    expect(await db.select().from(users).where(eq(users.id, mine.userId))).toHaveLength(1);
    await expect(photoStorage().read(mine.storageKeys[0]!)).resolves.toBeDefined();
  });

  it('refuses without the typed confirmation', async () => {
    const mine = await account();

    // A replayed sign-in body would validate against a password-only schema.
    expect((await destroy(mine.token, { password: PASSWORD })).status).toBe(400);
    expect((await destroy(mine.token, { password: PASSWORD, confirm: 'delete' })).status).toBe(400);

    expect(await db.select().from(users).where(eq(users.id, mine.userId))).toHaveLength(1);
  });

  it('empties every table the athlete owned', async () => {
    const mine = await account();

    const response = await destroy(mine.token);
    expect(response.status).toBe(200);

    expect(await db.select().from(users).where(eq(users.id, mine.userId))).toHaveLength(0);
    expect(
      await db.select().from(athleteProfiles).where(eq(athleteProfiles.id, mine.athleteId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(bodyCompositionSessions)
        .where(eq(bodyCompositionSessions.athleteId, mine.athleteId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(compositionPhotos)
        .where(eq(compositionPhotos.sessionId, mine.sessionId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(compositionMeasurements)
        .where(eq(compositionMeasurements.sessionId, mine.sessionId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(bodyFatEstimates).where(eq(bodyFatEstimates.sessionId, mine.sessionId)),
    ).toHaveLength(0);
  });

  it('takes the photographs off the disk', async () => {
    const mine = await account();
    expect(mine.storageKeys).toHaveLength(4);

    await destroy(mine.token);

    // The whole point: rows leave by cascade, files do not, and a file nobody
    // can name is a body photograph that is still there.
    for (const key of mine.storageKeys) {
      await expect(photoStorage().read(key)).resolves.toBeUndefined();
    }
  });

  it('reports what went', async () => {
    const mine = await account();

    const body = (await (await destroy(mine.token)).json()) as {
      ok: boolean;
      deleted: { compositionSessions: number; compositionPhotos: number; photoFilesRemoved: number };
    };

    expect(body.deleted).toEqual({
      compositionSessions: 1,
      compositionPhotos: 4,
      photoFilesRemoved: 4,
    });
  });

  it('leaves the token useless afterwards', async () => {
    const mine = await account();
    await destroy(mine.token);

    // The token is unexpired and correctly signed; the profile it names is
    // gone, which is what makes it worthless.
    const response = await app.request('/api/composition/sessions', {
      headers: { authorization: `Bearer ${mine.token}` },
    });
    expect(response.status).toBe(401);
  });

  it('does not touch another athlete', async () => {
    const mine = await account();
    const theirs = await account();

    await destroy(mine.token);

    expect(await db.select().from(users).where(eq(users.id, theirs.userId))).toHaveLength(1);
    expect(
      await db
        .select()
        .from(compositionPhotos)
        .where(eq(compositionPhotos.sessionId, theirs.sessionId)),
    ).toHaveLength(4);

    for (const key of theirs.storageKeys) {
      await expect(photoStorage().read(key)).resolves.toBeDefined();
    }

    const still = await app.request('/api/composition/sessions', {
      headers: { authorization: `Bearer ${theirs.token}` },
    });
    expect(still.status).toBe(200);
  });

  it('keeps the account when the photographs cannot be removed', async () => {
    const mine = await account();

    const failing = vi
      .spyOn(photoStorage(), 'removeAthlete')
      .mockRejectedValueOnce(new Error('disk is read-only'));

    // Deleting the row first would have left four photographs on a disk with
    // nothing left to say whose they were.
    expect((await destroy(mine.token)).status).toBe(500);
    expect(failing).toHaveBeenCalledOnce();

    expect(await db.select().from(users).where(eq(users.id, mine.userId))).toHaveLength(1);
    await expect(photoStorage().read(mine.storageKeys[0]!)).resolves.toBeDefined();

    failing.mockRestore();

    // And the retry works.
    expect((await destroy(mine.token)).status).toBe(200);
    await expect(photoStorage().read(mine.storageKeys[0]!)).resolves.toBeUndefined();
  });

  it('records the deletion without recording any of the body data', async () => {
    const mine = await account();
    await destroy(mine.token);

    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'account.deleted'))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);

    // The audit table holds ids, not a foreign key, so the record of the
    // deletion is not itself swept up by the cascade.
    expect(entry?.userId).toBe(mine.userId);
    expect(entry?.metadata).toMatchObject({
      compositionSessions: 1,
      compositionPhotos: 4,
      photoFilesRemoved: 4,
    });

    const recorded = JSON.stringify(entry?.metadata);
    expect(recorded).not.toContain('86.4');
    expect(recorded).not.toContain('38.1');
    // Nor a storage key, which names the file that used to hold the image.
    for (const key of mine.storageKeys) expect(recorded).not.toContain(key);
  });
});
