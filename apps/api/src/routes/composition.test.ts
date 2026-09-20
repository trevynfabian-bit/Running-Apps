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

async function list(query = '', auth = token): Promise<Response> {
  return app.request(`/api/composition/sessions${query}`, {
    headers: { authorization: `Bearer ${auth}` },
  });
}

describe('GET /api/composition/sessions', () => {
  it('returns the athlete sessions newest first', async () => {
    for (const capturedAt of [
      '2026-06-14T07:30:00.000Z',
      '2026-09-06T07:45:00.000Z',
      '2026-07-12T07:15:00.000Z',
    ]) {
      await post(sessionForm({}, { capturedAt }));
    }

    const body = (await (await list()).json()) as { sessions: { capturedAt: string }[] };
    const times = body.sessions.map((session) => Date.parse(session.capturedAt));

    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('returns each session four photos in a stable side order', async () => {
    const created = (await (await post(sessionForm())).json()) as { id: string };

    const body = (await (await list()).json()) as {
      sessions: { id: string; photos: { side: string; url: string; id: string }[] }[];
    };
    const session = body.sessions.find((s) => s.id === created.id);

    // Not insertion order: the app lays the set out the same way every time.
    expect(session?.photos.map((p) => p.side)).toEqual(['front', 'back', 'left', 'right']);
    for (const photo of session!.photos) {
      expect(photo.url).toBe(`/api/composition/sessions/${created.id}/photos/${photo.id}`);
    }
  });

  it('never shows one athlete the photos of another', async () => {
    const mine = (await (await post(sessionForm())).json()) as { id: string };

    const signUp = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'someone-else@example.test',
        password: 'a-long-enough-password',
        displayName: 'Someone Else',
      }),
    });
    const otherToken = ((await signUp.json()) as { token: string }).token;

    const theirs = (await (await list('', otherToken)).json()) as { sessions: { id: string }[] };

    expect(theirs.sessions).toEqual([]);
    expect(theirs.sessions.map((s) => s.id)).not.toContain(mine.id);
  });

  it('honours a limit and clamps a silly one', async () => {
    const one = (await (await list('?limit=1')).json()) as { sessions: unknown[] };
    expect(one.sessions).toHaveLength(1);

    // Zero and negative clamp up to one rather than returning nothing useful.
    const zero = (await (await list('?limit=0')).json()) as { sessions: unknown[] };
    expect(zero.sessions).toHaveLength(1);

    // Garbage falls back to the default instead of becoming NaN in the query.
    const nonsense = (await (await list('?limit=banana')).json()) as { sessions: unknown[] };
    expect(nonsense.sessions.length).toBeGreaterThan(0);

    const huge = (await (await list('?limit=99999')).json()) as { sessions: unknown[] };
    expect(huge.sessions.length).toBeLessThanOrEqual(100);
  });

  it('requires a signed-in athlete', async () => {
    const response = await app.request('/api/composition/sessions');
    expect(response.status).toBe(401);
  });
});

describe('POST /api/composition/sessions/:id/measurements', () => {
  async function newSession(): Promise<string> {
    const body = (await (await post(sessionForm())).json()) as { id: string };
    return body.id;
  }

  async function record(
    sessionId: string,
    measurements: unknown[],
    auth = token,
  ): Promise<Response> {
    return app.request(`/api/composition/sessions/${sessionId}/measurements`, {
      method: 'POST',
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify({ measurements }),
    });
  }

  it('converts what the athlete typed into canonical centimetres', async () => {
    const sessionId = await newSession();

    const response = await record(sessionId, [{ pointCode: 'waist', value: 34, unit: 'in' }]);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      measurements: { pointCode: string; valueCm: number; recordedUnit: string }[];
    };

    // 34 in is exactly 86.36 cm, and what they read is kept alongside it.
    expect(body.measurements[0]?.valueCm).toBeCloseTo(86.36, 10);
    expect(body.measurements[0]?.recordedUnit).toBe('in');
    expect(body.measurements[0]?.pointCode).toBe('waist');
  });

  it('defaults to centimetres', async () => {
    const sessionId = await newSession();
    const body = (await (
      await record(sessionId, [{ pointCode: 'waist', value: 86.4 }])
    ).json()) as { measurements: { valueCm: number; recordedUnit: string }[] };

    expect(body.measurements[0]?.valueCm).toBeCloseTo(86.4, 10);
    expect(body.measurements[0]?.recordedUnit).toBe('cm');
  });

  it('records a whole set in anatomical order', async () => {
    const sessionId = await newSession();

    const body = (await (
      await record(sessionId, [
        { pointCode: 'thigh', value: 55.1 },
        { pointCode: 'neck', value: 38 },
        { pointCode: 'waist', value: 86.4 },
      ])
    ).json()) as { measurements: { pointCode: string }[] };

    // Not the order they were sent: the app lists a session the same way
    // every time.
    expect(body.measurements.map((m) => m.pointCode)).toEqual(['neck', 'waist', 'thigh']);
  });

  it('replaces rather than duplicates when a point is measured again', async () => {
    const sessionId = await newSession();

    await record(sessionId, [{ pointCode: 'waist', value: 86.4 }]);
    const body = (await (
      await record(sessionId, [{ pointCode: 'waist', value: 85.1 }])
    ).json()) as { measurements: { pointCode: string; valueCm: number }[] };

    // One waist, and it is the one taken last.
    expect(body.measurements.filter((m) => m.pointCode === 'waist')).toHaveLength(1);
    expect(body.measurements[0]?.valueCm).toBeCloseTo(85.1, 10);
  });

  it('stamps a measurement with the session capture time, not now', async () => {
    const capturedAt = '2026-08-09T07:00:00.000Z';
    const created = (await (
      await post(sessionForm({}, { capturedAt, localDate: '2026-08-09' }))
    ).json()) as { id: string };

    const body = (await (
      await record(created.id, [{ pointCode: 'waist', value: 86.4 }])
    ).json()) as { measurements: { capturedAt: string }[] };

    // A correction months later must not relocate the reading.
    expect(body.measurements[0]?.capturedAt).toBe(capturedAt);
  });

  it('rejects a measurement outside the plausible range', async () => {
    const sessionId = await newSession();

    // A decimal point in the wrong place.
    const response = await record(sessionId, [{ pointCode: 'waist', value: 864 }]);
    expect(response.status).toBe(400);

    const after = (await (
      await record(sessionId, [{ pointCode: 'waist', value: 86.4 }])
    ).json()) as {
      measurements: unknown[];
    };
    expect(after.measurements).toHaveLength(1);
  });

  it('names an unknown measure point instead of dropping it', async () => {
    const sessionId = await newSession();

    const response = await record(sessionId, [{ pointCode: 'left_earlobe', value: 6 }]);
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: { details?: { unknown?: string[] } } };
    expect(body.error.details?.unknown).toEqual(['left_earlobe']);
  });

  it('refuses the same point twice in one payload', async () => {
    const sessionId = await newSession();

    const response = await record(sessionId, [
      { pointCode: 'waist', value: 86.4 },
      { pointCode: 'waist', value: 85.1 },
    ]);

    expect(response.status).toBe(400);
  });

  it('writes nothing when any measurement in the set is invalid', async () => {
    const sessionId = await newSession();

    await record(sessionId, [
      { pointCode: 'waist', value: 86.4 },
      { pointCode: 'chest', value: 9999 },
    ]);

    const listed = (await (await list()).json()) as {
      sessions: { id: string; measurements: unknown[] }[];
    };
    const session = listed.sessions.find((s) => s.id === sessionId);

    // The payload is rejected whole; the valid half is not quietly kept.
    expect(session?.measurements).toEqual([]);
  });

  it('reports another athlete session as not found, never as forbidden', async () => {
    const mine = await newSession();

    const signUp = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'intruder@example.test',
        password: 'a-long-enough-password',
        displayName: 'Intruder',
      }),
    });
    const intruder = ((await signUp.json()) as { token: string }).token;

    const response = await record(mine, [{ pointCode: 'waist', value: 86.4 }], intruder);

    // 403 would confirm the id is real and turn a list of uuids into a probe.
    expect(response.status).toBe(404);
  });

  it('requires a signed-in athlete', async () => {
    const sessionId = await newSession();

    const response = await app.request(`/api/composition/sessions/${sessionId}/measurements`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ measurements: [{ pointCode: 'waist', value: 86.4 }] }),
    });

    expect(response.status).toBe(401);
  });

  it('surfaces the measurements on the session listing', async () => {
    const sessionId = await newSession();
    await record(sessionId, [
      { pointCode: 'waist', value: 86.4 },
      { pointCode: 'chest', value: 99.2 },
    ]);

    const listed = (await (await list()).json()) as {
      sessions: { id: string; measurements: { pointCode: string }[] }[];
    };
    const session = listed.sessions.find((s) => s.id === sessionId);

    expect(session?.measurements.map((m) => m.pointCode)).toEqual(['chest', 'waist']);
  });
});

describe('GET /api/composition/points/:code/history', () => {
  // A dedicated athlete, so the history under test is exactly what this block
  // put there and not whatever earlier cases happened to record.
  let historyToken: string;

  beforeAll(async () => {
    const signUp = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'history@example.test',
        password: 'a-long-enough-password',
        displayName: 'History Tester',
      }),
    });
    historyToken = ((await signUp.json()) as { token: string }).token;

    // Three months of waist measurements, plus one session that skipped it.
    const series: [string, number | undefined][] = [
      ['2026-06-14T07:30:00.000Z', 88.2],
      ['2026-07-12T07:15:00.000Z', undefined],
      ['2026-08-09T08:00:00.000Z', 86.0],
      ['2026-09-06T07:45:00.000Z', 85.3],
    ];

    for (const [capturedAt, waist] of series) {
      const created = (await (
        await app.request('/api/composition/sessions', {
          method: 'POST',
          headers: { authorization: `Bearer ${historyToken}` },
          body: sessionForm({}, { capturedAt }),
        })
      ).json()) as { id: string };

      const measurements: Record<string, unknown>[] = [{ pointCode: 'chest', value: 99 }];
      if (waist !== undefined) measurements.push({ pointCode: 'waist', value: waist });

      await app.request(`/api/composition/sessions/${created.id}/measurements`, {
        method: 'POST',
        headers: { authorization: `Bearer ${historyToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ measurements }),
      });
    }
  }, 60_000);

  async function history(code: string, query = '', auth = historyToken): Promise<Response> {
    return app.request(`/api/composition/points/${code}/history${query}`, {
      headers: { authorization: `Bearer ${auth}` },
    });
  }

  it('returns the point and its values newest first', async () => {
    const body = (await (await history('waist')).json()) as {
      point: { code: string; label: string; guideText: string };
      entries: { valueCm: number; capturedAt: string }[];
    };

    expect(body.point.code).toBe('waist');
    expect(body.point.guideText.length).toBeGreaterThan(0);
    expect(body.entries.map((e) => e.valueCm)).toEqual([85.3, 86.0, 88.2]);
  });

  it('carries each entry change from the session before it', async () => {
    const body = (await (await history('waist')).json()) as {
      entries: { valueCm: number; changeCm?: number }[];
    };

    expect(body.entries[0]?.changeCm).toBeCloseTo(-0.7, 6);
    // The July session did not measure the waist, so the change skips it.
    expect(body.entries[1]?.changeCm).toBeCloseTo(-2.2, 6);
    // Nothing older exists, so the oldest has no change at all.
    expect(body.entries[2]?.changeCm).toBeUndefined();
  });

  it('omits sessions that did not measure the point', async () => {
    const body = (await (await history('waist')).json()) as { entries: unknown[] };
    const chest = (await (await history('chest')).json()) as { entries: unknown[] };

    // Four sessions, four chest readings, three waist readings.
    expect(chest.entries).toHaveLength(4);
    expect(body.entries).toHaveLength(3);
  });

  it('still gives the oldest row on a page its change', async () => {
    const page = (await (await history('waist', '?limit=2')).json()) as {
      entries: { valueCm: number; changeCm?: number }[];
    };

    expect(page.entries).toHaveLength(2);
    // The row behind the page is fetched so this delta does not vanish just
    // because of where the boundary fell.
    expect(page.entries[1]?.changeCm).toBeCloseTo(-2.2, 6);
  });

  it('returns an empty history for a point never measured', async () => {
    const body = (await (await history('thigh')).json()) as {
      point: { code: string };
      entries: unknown[];
    };

    expect(body.point.code).toBe('thigh');
    expect(body.entries).toEqual([]);
  });

  it('reports an unknown measure point as not found', async () => {
    expect((await history('left_earlobe')).status).toBe(404);
  });

  it('never mixes in another athlete measurements', async () => {
    // `token` belongs to the athlete used by the earlier blocks, who has waist
    // readings of their own.
    const mine = (await (await history('waist')).json()) as { entries: { valueCm: number }[] };
    const theirs = (await (await history('waist', '', token)).json()) as {
      entries: { valueCm: number }[];
    };

    expect(mine.entries.map((e) => e.valueCm)).toEqual([85.3, 86.0, 88.2]);
    expect(theirs.entries.map((e) => e.valueCm)).not.toEqual(mine.entries.map((e) => e.valueCm));
  });

  it('requires a signed-in athlete', async () => {
    expect((await app.request('/api/composition/points/waist/history')).status).toBe(401);
  });
});
