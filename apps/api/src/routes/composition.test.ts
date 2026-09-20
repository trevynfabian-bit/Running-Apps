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

describe('correcting and deleting a measurement', () => {
  async function seeded(): Promise<{ sessionId: string; capturedAt: string }> {
    const capturedAt = '2026-06-14T07:30:00.000Z';
    const created = (await (
      await post(sessionForm({}, { capturedAt, localDate: '2026-06-14' }))
    ).json()) as { id: string };

    await app.request(`/api/composition/sessions/${created.id}/measurements`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        measurements: [
          { pointCode: 'waist', value: 86.4 },
          { pointCode: 'chest', value: 99.2 },
        ],
      }),
    });

    return { sessionId: created.id, capturedAt };
  }

  async function patch(
    sessionId: string,
    pointCode: string,
    body: unknown,
    auth = token,
  ): Promise<Response> {
    return app.request(`/api/composition/sessions/${sessionId}/measurements/${pointCode}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function remove(sessionId: string, pointCode: string, auth = token): Promise<Response> {
    return app.request(`/api/composition/sessions/${sessionId}/measurements/${pointCode}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${auth}` },
    });
  }

  it('corrects a value without moving when it was taken', async () => {
    const { sessionId, capturedAt } = await seeded();

    const body = (await (await patch(sessionId, 'waist', { value: 85.1 })).json()) as {
      measurements: { pointCode: string; valueCm: number; capturedAt: string }[];
    };
    const waist = body.measurements.find((m) => m.pointCode === 'waist');

    expect(waist?.valueCm).toBeCloseTo(85.1, 6);
    // A typo fixed today does not relocate a June measurement.
    expect(waist?.capturedAt).toBe(capturedAt);
  });

  it('can change the unit the value was read in', async () => {
    const { sessionId } = await seeded();

    const body = (await (await patch(sessionId, 'waist', { value: 34, unit: 'in' })).json()) as {
      measurements: { pointCode: string; valueCm: number; recordedUnit: string }[];
    };
    const waist = body.measurements.find((m) => m.pointCode === 'waist');

    expect(waist?.recordedUnit).toBe('in');
    expect(waist?.valueCm).toBeCloseTo(86.36, 6);
  });

  it('leaves the other measurements alone', async () => {
    const { sessionId } = await seeded();

    const body = (await (await patch(sessionId, 'waist', { value: 85.1 })).json()) as {
      measurements: { pointCode: string; valueCm: number }[];
    };

    expect(body.measurements.find((m) => m.pointCode === 'chest')?.valueCm).toBeCloseTo(99.2, 6);
    expect(body.measurements).toHaveLength(2);
  });

  it('applies the same range check as recording does', async () => {
    const { sessionId } = await seeded();

    // The bound cannot drift between saving a measurement and fixing one.
    expect((await patch(sessionId, 'waist', { value: 864 })).status).toBe(400);
    expect((await patch(sessionId, 'waist', { value: 0 })).status).toBe(400);
  });

  it('refuses to correct a point with nothing recorded', async () => {
    const { sessionId } = await seeded();

    // Not an implicit create: the client believes a reading is there, and
    // inventing one would hide that its view is stale.
    expect((await patch(sessionId, 'thigh', { value: 55.1 })).status).toBe(404);
  });

  it('reports an unknown measure point as not found', async () => {
    const { sessionId } = await seeded();
    expect((await patch(sessionId, 'left_earlobe', { value: 6 })).status).toBe(404);
  });

  it('deletes one value and leaves the rest', async () => {
    const { sessionId } = await seeded();

    const body = (await (await remove(sessionId, 'waist')).json()) as {
      deleted: boolean;
      measurements: { pointCode: string }[];
    };

    expect(body.deleted).toBe(true);
    expect(body.measurements.map((m) => m.pointCode)).toEqual(['chest']);
  });

  it('is safe to retry', async () => {
    const { sessionId } = await seeded();

    await remove(sessionId, 'waist');
    const second = await remove(sessionId, 'waist');

    // A retry after a dropped connection is harmless, and still says plainly
    // that nothing was removed this time.
    expect(second.status).toBe(200);
    expect(((await second.json()) as { deleted: boolean }).deleted).toBe(false);
  });

  it('keeps the session when its last circumference goes', async () => {
    const { sessionId } = await seeded();

    await remove(sessionId, 'waist');
    await remove(sessionId, 'chest');

    const listed = (await (await list('?limit=100')).json()) as {
      sessions: { id: string; photos: unknown[]; measurements: unknown[] }[];
    };
    const session = listed.sessions.find((s) => s.id === sessionId);

    // It still holds photos; discarding a session is a separate action.
    expect(session).toBeDefined();
    expect(session?.photos).toHaveLength(4);
    expect(session?.measurements).toEqual([]);
  });

  it('drops the entry from that point history', async () => {
    const { sessionId } = await seeded();

    const before = (await (
      await app.request('/api/composition/points/waist/history', {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { entries: { sessionId: string }[] };
    expect(before.entries.some((e) => e.sessionId === sessionId)).toBe(true);

    await remove(sessionId, 'waist');

    const after = (await (
      await app.request('/api/composition/points/waist/history', {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { entries: { sessionId: string }[] };
    expect(after.entries.some((e) => e.sessionId === sessionId)).toBe(false);
  });

  it('will not let another athlete correct or delete', async () => {
    const { sessionId } = await seeded();

    const signUp = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'meddler@example.test',
        password: 'a-long-enough-password',
        displayName: 'Meddler',
      }),
    });
    const meddler = ((await signUp.json()) as { token: string }).token;

    expect((await patch(sessionId, 'waist', { value: 80 }, meddler)).status).toBe(404);
    expect((await remove(sessionId, 'waist', meddler)).status).toBe(404);

    // And the value is untouched.
    const body = (await (await patch(sessionId, 'waist', { value: 85.1 })).json()) as {
      measurements: { pointCode: string; valueCm: number }[];
    };
    expect(body.measurements.find((m) => m.pointCode === 'waist')?.valueCm).toBeCloseTo(85.1, 6);
  });

  it('requires a signed-in athlete', async () => {
    const { sessionId } = await seeded();

    const url = `/api/composition/sessions/${sessionId}/measurements/waist`;
    expect((await app.request(url, { method: 'DELETE' })).status).toBe(401);
    expect(
      (
        await app.request(url, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: 85.1 }),
        })
      ).status,
    ).toBe(401);
  });
});

describe('body fat from circumferences', () => {
  async function seeded(measurements: Record<string, number>): Promise<string> {
    const created = (await (await post(sessionForm())).json()) as { id: string };

    await app.request(`/api/composition/sessions/${created.id}/measurements`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        measurements: Object.entries(measurements).map(([pointCode, value]) => ({
          pointCode,
          value,
        })),
      }),
    });

    return created.id;
  }

  async function calculate(sessionId: string, body: unknown, auth = token): Promise<Response> {
    return app.request(`/api/composition/sessions/${sessionId}/body-fat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('computes a band from the session own measurements', async () => {
    const sessionId = await seeded({ waist: 86.4, neck: 38.1 });

    const response = await calculate(sessionId, {
      method: 'navy',
      variant: 'male',
      height: { value: 178, unit: 'cm' },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      method: string;
      valueLow: number;
      valueHigh: number;
      steps: { label: string }[];
    };

    expect(body.method).toBe('navy');
    expect(body.valueHigh).toBeGreaterThan(body.valueLow);
    // The steps are the feature, so they cross the wire.
    expect(body.steps.map((step) => step.label)).toContain('Waist minus neck');
  });

  it('converts height and weight from the units the athlete entered', async () => {
    const sessionId = await seeded({ waist: 86.4, neck: 38.1 });

    const inCm = (await (
      await calculate(sessionId, {
        method: 'navy',
        variant: 'male',
        height: { value: 178, unit: 'cm' },
      })
    ).json()) as { valueLow: number };

    const inInches = (await (
      await calculate(sessionId, {
        method: 'navy',
        variant: 'male',
        height: { value: 178 / 2.54, unit: 'in' },
      })
    ).json()) as { valueLow: number };

    expect(inInches.valueLow).toBeCloseTo(inCm.valueLow, 1);
  });

  it('runs the YMCA equation from waist and weight', async () => {
    const sessionId = await seeded({ waist: 86.4 });

    const response = await calculate(sessionId, {
      method: 'ymca',
      variant: 'male',
      weight: { value: 75, unit: 'kg' },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { method: string; steps: { unit?: string }[] };

    expect(body.method).toBe('ymca');
    // It converts into the units the equation is published in.
    expect(body.steps.map((step) => step.unit)).toContain('lb');
  });

  it('keeps both equations for one session', async () => {
    const sessionId = await seeded({ waist: 86.4, neck: 38.1 });

    await calculate(sessionId, {
      method: 'navy',
      variant: 'male',
      height: { value: 178, unit: 'cm' },
    });
    await calculate(sessionId, {
      method: 'ymca',
      variant: 'male',
      weight: { value: 75, unit: 'kg' },
    });

    const listed = (await (
      await app.request(`/api/composition/sessions/${sessionId}/body-fat`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { estimates: { method: string }[] };

    // An athlete comparing the two must not lose whichever ran second.
    expect(listed.estimates.map((estimate) => estimate.method).sort()).toEqual(['navy', 'ymca']);
  });

  it('replaces rather than duplicating when the same equation runs again', async () => {
    const sessionId = await seeded({ waist: 86.4, neck: 38.1 });

    await calculate(sessionId, {
      method: 'navy',
      variant: 'male',
      height: { value: 178, unit: 'cm' },
    });
    await calculate(sessionId, {
      method: 'navy',
      variant: 'male',
      height: { value: 180, unit: 'cm' },
    });

    const listed = (await (
      await app.request(`/api/composition/sessions/${sessionId}/body-fat`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { estimates: unknown[] };

    expect(listed.estimates).toHaveLength(1);
  });

  it('never labels a formula result better than moderate', async () => {
    const sessionId = await seeded({ waist: 86.4, neck: 38.1 });

    const body = (await (
      await calculate(sessionId, {
        method: 'navy',
        variant: 'male',
        height: { value: 178, unit: 'cm' },
      })
    ).json()) as { confidence: string };

    // A complete set of inputs makes the estimate usable, not certain.
    expect(body.confidence).toBe('moderate');
  });

  it('will not compute from circumferences the client supplies', async () => {
    const sessionId = await seeded({ waist: 86.4, neck: 38.1 });

    const response = await calculate(sessionId, {
      method: 'navy',
      variant: 'male',
      height: { value: 178, unit: 'cm' },
      // Ignored: the session's own record is the only source.
      waistCm: 70,
    });

    const body = (await response.json()) as { steps: { value: number }[] };
    expect(body.steps[0]?.value).toBeCloseTo(86.4 - 38.1, 1);
  });

  it('says which measurement to check when it cannot finish', async () => {
    // A neck larger than the waist takes log10 of a negative number.
    const sessionId = await seeded({ waist: 38, neck: 40 });

    const response = await calculate(sessionId, {
      method: 'navy',
      variant: 'male',
      height: { value: 178, unit: 'cm' },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { message: string; details?: { steps?: unknown[] } };
    };

    expect(body.error.message).toContain('girth');
    // The steps travel with the refusal so the athlete sees where it stopped.
    expect(body.error.details?.steps).toHaveLength(1);
  });

  it('refuses a session with no waist at all', async () => {
    const sessionId = await seeded({ chest: 99.2 });

    const response = await calculate(sessionId, {
      method: 'navy',
      variant: 'male',
      height: { value: 178, unit: 'cm' },
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
      'waist',
    );
  });

  it('reports another athlete session as not found', async () => {
    const sessionId = await seeded({ waist: 86.4, neck: 38.1 });

    const signUp = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'fat-intruder@example.test',
        password: 'a-long-enough-password',
        displayName: 'Intruder',
      }),
    });
    const intruder = ((await signUp.json()) as { token: string }).token;

    const response = await calculate(
      sessionId,
      { method: 'navy', variant: 'male', height: { value: 178, unit: 'cm' } },
      intruder,
    );
    expect(response.status).toBe(404);
  });

  it('requires a signed-in athlete', async () => {
    const sessionId = await seeded({ waist: 86.4, neck: 38.1 });

    const response = await app.request(`/api/composition/sessions/${sessionId}/body-fat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'navy', variant: 'male' }),
    });
    expect(response.status).toBe(401);
  });
});

describe('GET /api/composition/vision/status', () => {
  it('reports unavailable when no service is configured', async () => {
    const response = await app.request('/api/composition/vision/status', {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      configured: boolean;
      message: string;
      suggestFormula: boolean;
    };

    // The test environment configures no vision key, which is a working
    // instance with one method fewer rather than an outage.
    expect(body.status).toBe('unavailable');
    expect(body.configured).toBe(false);
    expect(body.suggestFormula).toBe(true);
    expect(body.message).toContain('measurements method');
  });

  it('says nothing about keys, hosts or providers', async () => {
    const response = await app.request('/api/composition/vision/status', {
      headers: { authorization: `Bearer ${token}` },
    });
    const raw = JSON.stringify(await response.json());

    for (const leak of ['apiKey', 'baseUrl', 'anthropic', 'VISION_']) {
      expect(raw).not.toContain(leak);
    }
  });

  it('requires a signed-in athlete', async () => {
    expect((await app.request('/api/composition/vision/status')).status).toBe(401);
  });
});

describe('POST /api/composition/sessions/:id/body-fat/photo', () => {
  it('refuses with a 503 and points at the formula when no service is configured', async () => {
    const created = (await (await post(sessionForm())).json()) as { id: string };

    const response = await app.request(`/api/composition/sessions/${created.id}/body-fat/photo`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      error: { message: string; details?: { suggestFormula?: boolean } };
    };

    // An athlete told only that something is broken has a dead end.
    expect(body.error.details?.suggestFormula).toBe(true);
    expect(body.error.message).toContain('measurements method');
  });

  it('never leaves a half-written estimate behind when it cannot run', async () => {
    const created = (await (await post(sessionForm())).json()) as { id: string };

    await app.request(`/api/composition/sessions/${created.id}/body-fat/photo`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    const listed = (await (
      await app.request(`/api/composition/sessions/${created.id}/body-fat`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { estimates: unknown[] };

    expect(listed.estimates).toEqual([]);
  });

  it('reports another athlete session as not found', async () => {
    const created = (await (await post(sessionForm())).json()) as { id: string };

    const signUp = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'photo-intruder@example.test',
        password: 'a-long-enough-password',
        displayName: 'Intruder',
      }),
    });
    const intruder = ((await signUp.json()) as { token: string }).token;

    const response = await app.request(`/api/composition/sessions/${created.id}/body-fat/photo`, {
      method: 'POST',
      headers: { authorization: `Bearer ${intruder}` },
    });

    // Checked before the service is consulted, so a stranger cannot make us
    // spend a request on someone else's photos.
    expect(response.status).toBe(404);
  });

  it('requires a signed-in athlete', async () => {
    const created = (await (await post(sessionForm())).json()) as { id: string };

    const response = await app.request(`/api/composition/sessions/${created.id}/body-fat/photo`, {
      method: 'POST',
    });
    expect(response.status).toBe(401);
  });
});

describe('GET /api/composition/body-fat/history', () => {
  let historyToken: string;
  const created: { id: string; capturedAt: string }[] = [];

  beforeAll(async () => {
    const signUp = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'fat-history@example.test',
        password: 'a-long-enough-password',
        displayName: 'Fat History',
      }),
    });
    historyToken = ((await signUp.json()) as { token: string }).token;

    for (const capturedAt of [
      '2026-06-14T07:30:00.000Z',
      '2026-07-12T07:15:00.000Z',
      '2026-09-06T07:45:00.000Z',
    ]) {
      const session = (await (
        await app.request('/api/composition/sessions', {
          method: 'POST',
          headers: { authorization: `Bearer ${historyToken}` },
          body: sessionForm({}, { capturedAt }),
        })
      ).json()) as { id: string };
      created.push({ id: session.id, capturedAt });

      await app.request(`/api/composition/sessions/${session.id}/measurements`, {
        method: 'POST',
        headers: { authorization: `Bearer ${historyToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          measurements: [
            { pointCode: 'waist', value: 86.4 },
            { pointCode: 'neck', value: 38.1 },
          ],
        }),
      });

      await app.request(`/api/composition/sessions/${session.id}/body-fat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${historyToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          method: 'navy',
          variant: 'male',
          height: { value: 178, unit: 'cm' },
        }),
      });
    }

    // One session also gets the other equation, so the method filter has
    // something to narrow.
    await app.request(`/api/composition/sessions/${created[0]!.id}/body-fat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${historyToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        method: 'ymca',
        variant: 'male',
        weight: { value: 75, unit: 'kg' },
      }),
    });
  }, 60_000);

  async function history(query = '', auth = historyToken): Promise<Response> {
    return app.request(`/api/composition/body-fat/history${query}`, {
      headers: { authorization: `Bearer ${auth}` },
    });
  }

  it('returns estimates newest first, dated by their session', async () => {
    const body = (await (await history('?method=navy')).json()) as {
      entries: { sessionId: string; capturedAt: string }[];
    };

    const times = body.entries.map((entry) => Date.parse(entry.capturedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));

    // The June estimate carries June's date even though it was computed now.
    const june = body.entries.find((entry) => entry.sessionId === created[0]!.id);
    expect(june?.capturedAt).toBe(created[0]!.capturedAt);
  });

  it('narrows to one equation so a line is one series', async () => {
    const navy = (await (await history('?method=navy')).json()) as { entries: unknown[] };
    const ymca = (await (await history('?method=ymca')).json()) as { entries: unknown[] };

    // Two methods plotted as one series would read as a body that jumped
    // several points and back.
    expect(navy.entries).toHaveLength(3);
    expect(ymca.entries).toHaveLength(1);
  });

  it('returns every method when none is named', async () => {
    const body = (await (await history()).json()) as {
      entries: unknown[];
      methods: string[];
    };

    expect(body.entries).toHaveLength(4);
    // Only the methods actually present, so a client offers real choices.
    expect(body.methods.sort()).toEqual(['navy', 'ymca']);
  });

  it('rejects a method that does not exist', async () => {
    expect((await history('?method=calipers')).status).toBe(400);
  });

  it('honours a limit and clamps a silly one', async () => {
    const one = (await (await history('?limit=1')).json()) as { entries: unknown[] };
    expect(one.entries).toHaveLength(1);

    const zero = (await (await history('?limit=0')).json()) as { entries: unknown[] };
    expect(zero.entries).toHaveLength(1);

    const nonsense = (await (await history('?limit=banana')).json()) as { entries: unknown[] };
    expect(nonsense.entries.length).toBeGreaterThan(0);
  });

  it('never shows one athlete the estimates of another', async () => {
    const theirs = (await (await history('', token)).json()) as {
      entries: { sessionId: string }[];
    };

    const mine = new Set(created.map((session) => session.id));
    expect(theirs.entries.some((entry) => mine.has(entry.sessionId))).toBe(false);
  });

  it('requires a signed-in athlete', async () => {
    expect((await app.request('/api/composition/body-fat/history')).status).toBe(401);
  });
});

describe('GET /api/composition/sessions/options', () => {
  let optionsToken: string;
  let fullId: string;
  let photosOnlyId: string;

  beforeAll(async () => {
    const signUp = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'options@example.test',
        password: 'a-long-enough-password',
        displayName: 'Options',
      }),
    });
    optionsToken = ((await signUp.json()) as { token: string }).token;

    const create = async (capturedAt: string): Promise<string> => {
      const created = (await (
        await app.request('/api/composition/sessions', {
          method: 'POST',
          headers: { authorization: `Bearer ${optionsToken}` },
          body: sessionForm({}, { capturedAt }),
        })
      ).json()) as { id: string };
      return created.id;
    };

    photosOnlyId = await create('2026-06-14T07:30:00.000Z');
    fullId = await create('2026-09-06T07:45:00.000Z');

    await app.request(`/api/composition/sessions/${fullId}/measurements`, {
      method: 'POST',
      headers: { authorization: `Bearer ${optionsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        measurements: [
          { pointCode: 'waist', value: 86.4 },
          { pointCode: 'neck', value: 38.1 },
          { pointCode: 'chest', value: 99.2 },
        ],
      }),
    });
  }, 60_000);

  async function options(query = '', auth = optionsToken): Promise<Response> {
    return app.request(`/api/composition/sessions/options${query}`, {
      headers: { authorization: `Bearer ${auth}` },
    });
  }

  it('counts photos and measurements without multiplying them together', async () => {
    const body = (await (await options()).json()) as {
      sessions: { id: string; photoCount: number; measurementCount: number }[];
    };
    const full = body.sessions.find((session) => session.id === fullId);

    // Joining two one-to-many tables in one statement would report 12 of each
    // for four photos and three measurements.
    expect(full?.photoCount).toBe(4);
    expect(full?.measurementCount).toBe(3);
  });

  it('returns sessions newest first', async () => {
    const body = (await (await options()).json()) as { sessions: { id: string }[] };

    expect(body.sessions[0]?.id).toBe(fullId);
    expect(body.sessions[1]?.id).toBe(photosOnlyId);
  });

  it('counts a session with photos but no measurements correctly', async () => {
    const body = (await (await options()).json()) as {
      sessions: { id: string; photoCount: number; measurementCount: number; comparable: boolean }[];
    };
    const photosOnly = body.sessions.find((session) => session.id === photosOnlyId);

    expect(photosOnly?.photoCount).toBe(4);
    expect(photosOnly?.measurementCount).toBe(0);
    // Photos alone still make a visual comparison possible.
    expect(photosOnly?.comparable).toBe(true);
  });

  it('carries no photo or measurement records, only counts', async () => {
    const body = (await (await options()).json()) as { sessions: Record<string, unknown>[] };

    // A picker showing ten sessions should not fetch forty photo records.
    for (const session of body.sessions) {
      expect(session).not.toHaveProperty('photos');
      expect(session).not.toHaveProperty('measurements');
    }
  });

  it('honours a limit and clamps a silly one', async () => {
    const one = (await (await options('?limit=1')).json()) as { sessions: unknown[] };
    expect(one.sessions).toHaveLength(1);

    const zero = (await (await options('?limit=0')).json()) as { sessions: unknown[] };
    expect(zero.sessions).toHaveLength(1);

    const nonsense = (await (await options('?limit=banana')).json()) as { sessions: unknown[] };
    expect(nonsense.sessions.length).toBeGreaterThan(0);
  });

  it('never shows one athlete the sessions of another', async () => {
    const theirs = (await (await options('', token)).json()) as { sessions: { id: string }[] };

    expect(theirs.sessions.some((session) => session.id === fullId)).toBe(false);
  });

  it('requires a signed-in athlete', async () => {
    expect((await app.request('/api/composition/sessions/options')).status).toBe(401);
  });
});

describe('serving and pairing photos', () => {
  let photoToken: string;
  let juneId: string;
  let septemberId: string;

  beforeAll(async () => {
    const signUp = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'photo-compare@example.test',
        password: 'a-long-enough-password',
        displayName: 'Photo Compare',
      }),
    });
    photoToken = ((await signUp.json()) as { token: string }).token;

    const create = async (capturedAt: string): Promise<string> => {
      const created = (await (
        await app.request('/api/composition/sessions', {
          method: 'POST',
          headers: { authorization: `Bearer ${photoToken}` },
          body: sessionForm({}, { capturedAt }),
        })
      ).json()) as { id: string };
      return created.id;
    };

    juneId = await create('2026-06-14T07:30:00.000Z');
    septemberId = await create('2026-09-06T07:45:00.000Z');
  }, 60_000);

  describe('GET /sessions/:id/photos/:photoId', () => {
    async function firstPhoto(sessionId: string, auth = photoToken) {
      const listed = (await (
        await app.request('/api/composition/sessions?limit=100', {
          headers: { authorization: `Bearer ${auth}` },
        })
      ).json()) as { sessions: { id: string; photos: { id: string; url: string }[] }[] };

      return listed.sessions.find((session) => session.id === sessionId)!.photos[0]!;
    }

    it('serves the bytes at the url the session listing gave', async () => {
      const photo = await firstPhoto(juneId);

      // The url in every DTO has pointed here since the sessions endpoint
      // landed; this is the route it names.
      const response = await app.request(photo.url, {
        headers: { authorization: `Bearer ${photoToken}` },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/jpeg');
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    });

    it('marks the response private and non-sniffable', async () => {
      const photo = await firstPhoto(juneId);
      const response = await app.request(photo.url, {
        headers: { authorization: `Bearer ${photoToken}` },
      });

      // Private so no shared cache between here and the device keeps a body
      // photo; nosniff so nothing interprets it as a document.
      expect(response.headers.get('cache-control')).toContain('private');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('will not serve a photo through a session it does not belong to', async () => {
      const photo = await firstPhoto(juneId);

      // Same athlete, wrong session: a photo id is not a capability on its own.
      const response = await app.request(
        `/api/composition/sessions/${septemberId}/photos/${photo.id}`,
        { headers: { authorization: `Bearer ${photoToken}` } },
      );

      expect(response.status).toBe(404);
    });

    it('will not serve another athlete photo', async () => {
      const photo = await firstPhoto(juneId);

      const response = await app.request(photo.url, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(404);
    });

    it('requires a signed-in athlete', async () => {
      const photo = await firstPhoto(juneId);
      expect((await app.request(photo.url)).status).toBe(401);
    });
  });

  describe('GET /compare/photos', () => {
    it('pairs all four sides between two sessions', async () => {
      const body = (await (
        await app.request(
          `/api/composition/compare/photos?earlierId=${juneId}&laterId=${septemberId}`,
          { headers: { authorization: `Bearer ${photoToken}` } },
        )
      ).json()) as {
        photos: { side: string; comparable: boolean; earlier?: unknown; later?: unknown }[];
      };

      expect(body.photos.map((pair) => pair.side)).toEqual(['front', 'back', 'left', 'right']);
      expect(body.photos.every((pair) => pair.comparable)).toBe(true);
    });

    it('orders the pair by date whichever way the ids were given', async () => {
      const body = (await (
        await app.request(
          `/api/composition/compare/photos?earlierId=${septemberId}&laterId=${juneId}`,
          { headers: { authorization: `Bearer ${photoToken}` } },
        )
      ).json()) as { earlier: { id: string }; later: { id: string } };

      // Which one the athlete tapped first says nothing about which came first.
      expect(body.earlier.id).toBe(juneId);
      expect(body.later.id).toBe(septemberId);
    });

    it('resolves a window to its widest pair', async () => {
      const body = (await (
        await app.request('/api/composition/compare/photos', {
          headers: { authorization: `Bearer ${photoToken}` },
        })
      ).json()) as { earlier: { id: string }; later: { id: string } };

      expect(body.earlier.id).toBe(juneId);
      expect(body.later.id).toBe(septemberId);
    });

    it('refuses a session compared against itself', async () => {
      const response = await app.request(
        `/api/composition/compare/photos?earlierId=${juneId}&laterId=${juneId}`,
        { headers: { authorization: `Bearer ${photoToken}` } },
      );

      expect(response.status).toBe(400);
    });

    it('refuses a window holding fewer than two sessions', async () => {
      const response = await app.request('/api/composition/compare/photos?days=1', {
        headers: { authorization: `Bearer ${photoToken}` },
      });

      // One session is not a comparison, and widening the range silently would
      // answer a question nobody asked.
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain('two sessions');
    });

    it('reports another athlete session as not found', async () => {
      const response = await app.request(
        `/api/composition/compare/photos?earlierId=${juneId}&laterId=${septemberId}`,
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(response.status).toBe(404);
    });

    it('requires a signed-in athlete', async () => {
      expect((await app.request('/api/composition/compare/photos')).status).toBe(401);
    });
  });
});
