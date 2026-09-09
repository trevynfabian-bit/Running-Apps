/**
 * Session creation and photo upload tests.
 *
 * Real migrations, real auth, real files on disk in a temporary photo store.
 * Images are tiny hand-built JPEG and PNG headers: enough for the store to
 * identify them and read their dimensions, which is all the API does with
 * them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bodyCompositionSessionSchema, compositionPhotoSchema } from '@running/contracts';
import { toLocalDate } from '@running/core';

import { loadEnv, setEnvForTesting } from '../env.js';
import { getDb, resetDbForTesting, type Database } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { resetProviderRegistry } from '../providers/registry.js';
import { athleteProfiles } from '../db/schema.js';
import { setPhotoStoreForTesting } from './photo-store.js';

const DATA_DIR = 'memory://running-os-body-composition-photo-tests';
const PHOTO_DIR = mkdtempSync(join(tmpdir(), 'running-os-photos-'));

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
    headers: { authorization: `Bearer ${bearer}`, ...(init.headers ?? {}) },
  });
}

async function createSession(body?: Record<string, unknown>): Promise<string> {
  const response = await authed('/api/body-composition/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  expect(response.status).toBe(201);
  return (await json(response)).id as string;
}

const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >> 16) & 0xff,
  (n >> 8) & 0xff,
  n & 0xff,
];

/** Signature + IHDR + IEND. The CRCs are wrong; the API never checks them. */
function pngBytes(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32(13),
    0x49,
    0x48,
    0x44,
    0x52,
    ...u32(width),
    ...u32(height),
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...u32(0),
    0x49,
    0x45,
    0x4e,
    0x44,
    0xae,
    0x42,
    0x60,
    0x82,
  ]);
}

/** SOI, an APP0 segment, a baseline SOF0 carrying the size, EOI. */
function jpegBytes(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    ...u16(height),
    ...u16(width),
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
    0xff,
    0xd9,
  ]);
}

async function putRaw(
  sessionId: string,
  side: string,
  bytes: Uint8Array,
  options: { contentType?: string; query?: string; bearer?: string } = {},
): Promise<Response> {
  return authed(
    `/api/body-composition/sessions/${sessionId}/photos/${side}${options.query ?? ''}`,
    {
      method: 'PUT',
      headers: { 'content-type': options.contentType ?? 'image/jpeg' },
      body: bytes,
    },
    options.bearer,
  );
}

async function putMultipart(
  sessionId: string,
  side: string,
  bytes: Uint8Array,
  fields: Record<string, string> = {},
): Promise<Response> {
  const form = new FormData();
  form.set('photo', new File([bytes], `${side}.png`, { type: 'image/png' }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return authed(`/api/body-composition/sessions/${sessionId}/photos/${side}`, {
    method: 'PUT',
    body: form,
  });
}

beforeAll(async () => {
  setEnvForTesting(
    loadEnv({
      NODE_ENV: 'test',
      USE_MOCK_DATA: true,
      DATABASE_URL: '',
      PGLITE_DIR: DATA_DIR,
      BODY_PHOTO_DIR: PHOTO_DIR,
      AUTH_JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
      TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
      AI_API_KEY: '',
    }),
  );

  resetDbForTesting();
  resetProviderRegistry();
  setPhotoStoreForTesting(undefined);

  const handle = await getDb({ dataDir: DATA_DIR });
  db = handle.db;
  await runMigrations({ dataDir: DATA_DIR });

  const { createApp } = await import('../app.js');
  app = createApp();

  const signedUp = await signUp('photos@example.com');
  token = signedUp.token;
  athleteId = signedUp.athleteId;
  await db
    .update(athleteProfiles)
    .set({ timezone: 'Asia/Jakarta' })
    .where(eq(athleteProfiles.id, athleteId));
}, 120_000);

afterAll(async () => {
  const handle = await getDb({ dataDir: DATA_DIR });
  await handle.close();
  setEnvForTesting(undefined);
  setPhotoStoreForTesting(undefined);
  rmSync(PHOTO_DIR, { recursive: true, force: true });
});

describe('POST /api/body-composition/sessions', () => {
  it('starts a session dated in the athlete timezone, with nothing attached yet', async () => {
    const response = await authed('/api/body-composition/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capturedAt: '2026-09-06T06:40:00+07:00', weightKilograms: 64.2 }),
    });
    expect(response.status).toBe(201);
    const session = bodyCompositionSessionSchema.parse(await json(response));

    expect(session.capturedAt).toBe('2026-09-05T23:40:00.000Z');
    // Jakarta morning, even though it is still the previous day in UTC.
    expect(session.localDate).toBe('2026-09-06');
    expect(session.weightKilograms).toBe(64.2);
    expect(session.photos).toEqual([]);
    expect(session.measurements).toEqual([]);
    expect(session.estimates).toEqual([]);
    expect(session.estimateRequirements.map((r) => r.formula)).toEqual(['us_navy', 'ymca']);
  });

  it('treats an empty body as "now"', async () => {
    const response = await authed('/api/body-composition/sessions', { method: 'POST' });
    expect(response.status).toBe(201);
    const session = bodyCompositionSessionSchema.parse(await json(response));
    expect(session.localDate).toBe(toLocalDate(new Date(), 'Asia/Jakarta'));
    expect(Date.now() - new Date(session.capturedAt).getTime()).toBeLessThan(10_000);
  });

  it('rejects values that make no sense', async () => {
    const response = await authed('/api/body-composition/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ weightKilograms: -3 }),
    });
    expect(response.status).toBe(400);
    expect((await json(response)).error.code).toBe('validation_failed');
  });
});

describe('PUT and GET /api/body-composition/sessions/:id/photos/:side', () => {
  let sessionId: string;

  beforeAll(async () => {
    sessionId = await createSession({ capturedAt: '2026-09-06T06:40:00+07:00' });
  });

  it('stores a multipart photo and reads its dimensions from the bytes', async () => {
    const response = await putMultipart(sessionId, 'front', pngBytes(3, 2));
    expect(response.status).toBe(200);
    const photo = compositionPhotoSchema.parse(await json(response));

    expect(photo.side).toBe('front');
    expect(photo.contentType).toBe('image/png');
    expect(photo.widthPx).toBe(3);
    expect(photo.heightPx).toBe(2);
    expect(photo.url).toBe(`/api/body-composition/sessions/${sessionId}/photos/front`);
    // Photos default to the session's capture time.
    expect(photo.capturedAt).toBe('2026-09-05T23:40:00.000Z');
    expect(
      existsSync(join(PHOTO_DIR, 'athletes', athleteId, 'sessions', sessionId, 'front.png')),
    ).toBe(true);
  });

  it('treats a second upload of the same side as a retake', async () => {
    const before = compositionPhotoSchema.parse(
      await json(await authed(`/api/body-composition/sessions/${sessionId}`)).then(
        (s) => s.photos[0],
      ),
    );
    const response = await putRaw(sessionId, 'front', jpegBytes(5, 4));
    expect(response.status).toBe(200);
    const photo = compositionPhotoSchema.parse(await json(response));

    expect(photo.id).toBe(before.id);
    expect(photo.contentType).toBe('image/jpeg');
    expect(photo.widthPx).toBe(5);
    expect(photo.heightPx).toBe(4);

    const dir = join(PHOTO_DIR, 'athletes', athleteId, 'sessions', sessionId);
    expect(existsSync(join(dir, 'front.jpg'))).toBe(true);
    expect(existsSync(join(dir, 'front.png'))).toBe(false);

    const session = bodyCompositionSessionSchema.parse(
      await json(await authed(`/api/body-composition/sessions/${sessionId}`)),
    );
    expect(session.photos).toHaveLength(1);
  });

  it('serves the bytes back to the owner, uncached', async () => {
    const response = await authed(`/api/body-composition/sessions/${sessionId}/photos/front`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(jpegBytes(5, 4));
  });

  it('accepts a capture time with the upload', async () => {
    const response = await putMultipart(sessionId, 'back', pngBytes(1, 1), {
      capturedAt: '2026-09-06T06:45:00+07:00',
    });
    expect(response.status).toBe(200);
    expect((await json(response)).capturedAt).toBe('2026-09-05T23:45:00.000Z');

    const bad = await putRaw(sessionId, 'back', jpegBytes(1, 1), {
      query: '?capturedAt=yesterday',
    });
    expect(bad.status).toBe(400);
  });

  it('lists the four sides in display order once they are all there', async () => {
    expect((await putRaw(sessionId, 'right', jpegBytes(2, 2))).status).toBe(200);
    expect((await putRaw(sessionId, 'left', jpegBytes(2, 2))).status).toBe(200);

    const session = bodyCompositionSessionSchema.parse(
      await json(await authed(`/api/body-composition/sessions/${sessionId}`)),
    );
    expect(session.photos.map((p) => p.side)).toEqual(['front', 'back', 'left', 'right']);

    // The summary lists it with all four photos (a newer "now" session from
    // the earlier test is the latest, so look it up by id).
    const summary = await json(await authed('/api/body-composition/summary'));
    const listed = summary.sessions.find((s: { id: string }) => s.id === sessionId);
    expect(listed.photos.map((p: { url: string }) => p.url)).toHaveLength(4);
  });

  it('refuses what is not a photo, and sides that do not exist', async () => {
    const text = await putRaw(
      sessionId,
      'front',
      new TextEncoder().encode('definitely not a photo, just words'),
    );
    expect(text.status).toBe(400);
    expect((await json(text)).error.message).toMatch(/not a photo/);

    const empty = await putRaw(sessionId, 'front', new Uint8Array());
    expect(empty.status).toBe(400);

    const side = await putRaw(sessionId, 'top', jpegBytes(1, 1));
    expect(side.status).toBe(400);

    const missingField = await authed(`/api/body-composition/sessions/${sessionId}/photos/front`, {
      method: 'PUT',
      body: new FormData(),
    });
    expect(missingField.status).toBe(400);
  });

  it('refuses a photo over the size limit', async () => {
    const huge = new Uint8Array(10 * 1024 * 1024 + 1);
    huge.set(jpegBytes(1, 1));
    const response = await putRaw(sessionId, 'front', huge);
    expect(response.status).toBe(413);
    expect((await json(response)).error.message).toMatch(/too large/);
  });

  it("hides other athletes' sessions completely", async () => {
    const other = await signUp('other-photos@example.com');
    expect(
      (await putRaw(sessionId, 'front', jpegBytes(1, 1), { bearer: other.token })).status,
    ).toBe(404);
    expect(
      (await authed(`/api/body-composition/sessions/${sessionId}/photos/front`, {}, other.token))
        .status,
    ).toBe(404);
    expect(
      (await authed(`/api/body-composition/sessions/${sessionId}`, {}, other.token)).status,
    ).toBe(404);

    const unknown = randomUUID();
    expect((await putRaw(unknown, 'front', jpegBytes(1, 1))).status).toBe(404);
    expect((await authed(`/api/body-composition/sessions/${unknown}`)).status).toBe(404);
  });
});
