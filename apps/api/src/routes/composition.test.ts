/**
 * Composition session upload.
 *
 * Runs the real routing stack against embedded Postgres and real storage, so
 * the multipart handling, the constraints and the failure cleanup are all
 * genuinely exercised.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';

import { loadEnv, setEnvForTesting } from '../env.js';
import { getDb, resetDbForTesting, type Database } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { resetProviderRegistry } from '../providers/registry.js';
import { bodyCompositionSessions, compositionPhotos } from '../db/schema.js';
import { photoStorage, resetPhotoStorageForTesting } from '../services/photo-storage.js';

const DATA_DIR = 'memory://running-os-composition-routes';

let app: Hono;
let db: Database;
let token: string;
let photoRoot: string;

const jpeg = (marker = 0xe0): Blob =>
  new Blob([Uint8Array.from([0xff, 0xd8, 0xff, marker, 0x00, 0x10, 0x4a, 0x46])], {
    type: 'image/jpeg',
  });

beforeAll(async () => {
  photoRoot = await mkdtemp(path.join(tmpdir(), 'running-os-composition-'));

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

  const signUp = await app.request('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'photos@example.test',
      password: 'a-long-enough-password',
      displayName: 'Photo Tester',
    }),
  });
  token = ((await signUp.json()) as { token: string }).token;
}, 120_000);

afterAll(async () => {
  const handle = await getDb({ dataDir: DATA_DIR });
  await handle.close();
  await rm(photoRoot, { recursive: true, force: true });
  setEnvForTesting(undefined);
  resetPhotoStorageForTesting();
});

function sessionForm(
  sides: Partial<Record<'front' | 'back' | 'left' | 'right', Blob>> = {},
  fields: Record<string, string> = {},
): FormData {
  const form = new FormData();
  const all = { front: jpeg(), back: jpeg(), left: jpeg(), right: jpeg(), ...sides };
  for (const [side, blob] of Object.entries(all)) {
    if (blob) form.append(side, blob, `${side}.jpg`);
  }
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

async function post(form: FormData, auth = true): Promise<Response> {
  return app.request('/api/composition/sessions', {
    method: 'POST',
    headers: auth ? { authorization: `Bearer ${token}` } : {},
    body: form,
  });
}

describe('POST /api/composition/sessions', () => {
  it('stores four photos and returns the session', async () => {
    const response = await post(sessionForm({}, { note: 'Morning, fasted' }));
    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      id: string;
      note?: string;
      localDate: string;
      photos: { id: string; side: string; url: string; byteSize: number }[];
    };

    expect(body.note).toBe('Morning, fasted');
    expect(body.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.photos.map((p) => p.side).sort()).toEqual(['back', 'front', 'left', 'right']);
    expect(body.photos.every((p) => p.byteSize > 0)).toBe(true);

    // The client is handed a route, never a storage path.
    for (const photo of body.photos) {
      expect(photo.url).toBe(`/api/composition/sessions/${body.id}/photos/${photo.id}`);
    }
  });

  it('writes a row per side and the bytes behind each one', async () => {
    const body = (await (await post(sessionForm())).json()) as { id: string };

    const rows = await db
      .select()
      .from(compositionPhotos)
      .where(eq(compositionPhotos.sessionId, body.id));

    expect(rows).toHaveLength(4);

    for (const row of rows) {
      // Keys are minted by the server and scoped to this session.
      expect(row.storageKey).toContain(`/${body.id}/`);
      await expect(photoStorage().read(row.storageKey)).resolves.toBeDefined();
    }
  });

  it('honours a capture time the client supplies', async () => {
    const capturedAt = '2026-08-09T23:30:00.000Z';
    const body = (await (
      await post(sessionForm({}, { capturedAt, localDate: '2026-08-10' }))
    ).json()) as { capturedAt: string; localDate: string };

    // An athlete offline since the morning can say when the photos were taken.
    expect(body.capturedAt).toBe(capturedAt);
    expect(body.localDate).toBe('2026-08-10');
  });

  it('refuses a partial set and names what is missing', async () => {
    const response = await post(sessionForm({ left: undefined, right: undefined }));

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { message: string; details?: { missing?: string[] } };
    };
    expect(body.error.details?.missing).toEqual(['left', 'right']);
  });

  it('stores nothing when one photo in the set is bad', async () => {
    const before = await db.select().from(bodyCompositionSessions);

    const notAPhoto = new Blob([new TextEncoder().encode('<svg onload="alert(1)"></svg>')], {
      type: 'image/jpeg',
    });
    const response = await post(sessionForm({ back: notAPhoto }));

    expect(response.status).toBe(415);

    // The whole set is rejected: no session row, and nothing half-written.
    const after = await db.select().from(bodyCompositionSessions);
    expect(after).toHaveLength(before.length);
  });

  it('refuses a body that is not multipart', async () => {
    const response = await app.request('/api/composition/sessions', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'no photos here' }),
    });

    expect(response.status).toBe(400);
  });

  it('requires a signed-in athlete', async () => {
    const response = await post(sessionForm(), false);
    expect(response.status).toBe(401);
  });

  it('keeps each session photos separate', async () => {
    const first = (await (await post(sessionForm())).json()) as { id: string };
    const second = (await (await post(sessionForm())).json()) as { id: string };

    expect(second.id).not.toBe(first.id);

    const firstRows = await db
      .select()
      .from(compositionPhotos)
      .where(eq(compositionPhotos.sessionId, first.id));
    const secondRows = await db
      .select()
      .from(compositionPhotos)
      .where(eq(compositionPhotos.sessionId, second.id));

    const keys = new Set([...firstRows, ...secondRows].map((r) => r.storageKey));
    expect(keys.size).toBe(8);
  });
});
