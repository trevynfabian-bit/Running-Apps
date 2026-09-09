/**
 * Session history endpoint tests: order, paging, date range and isolation.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';

import { sessionHistorySchema } from '@running/contracts';

import { loadEnv, setEnvForTesting } from '../env.js';
import { getDb, resetDbForTesting, type Database } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { resetProviderRegistry } from '../providers/registry.js';
import { bodyCompositionSessions } from '../db/schema.js';

const DATA_DIR = 'memory://running-os-body-composition-history-tests';

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

async function history(query = '', bearer = token): Promise<Response> {
  return app.request(`/api/body-composition/sessions${query}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
}

/** Ten sessions, one per day from 2026-08-01, captured at 06:30 UTC. */
const DAYS = Array.from({ length: 10 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`);

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

  const signedUp = await signUp('history@example.com');
  token = signedUp.token;
  athleteId = signedUp.athleteId;

  // Inserted oldest first so ordering in the response is the API's doing.
  await db.insert(bodyCompositionSessions).values(
    DAYS.map((day) => ({
      athleteId,
      capturedAt: new Date(`${day}T06:30:00Z`),
      localDate: day,
      weightKilograms: 70,
    })),
  );
}, 120_000);

afterAll(async () => {
  const handle = await getDb({ dataDir: DATA_DIR });
  await handle.close();
  setEnvForTesting(undefined);
});

describe('GET /api/body-composition/sessions', () => {
  it('lists sessions newest first with the total', async () => {
    const response = await history();
    expect(response.status).toBe(200);
    const page = sessionHistorySchema.parse(await json(response));

    expect(page.total).toBe(10);
    expect(page.sessions).toHaveLength(10);
    expect(page.sessions.map((s) => s.localDate)).toEqual([...DAYS].reverse());
    expect(page.nextCursor).toBeUndefined();
    // Each entry is a full session: the history card can show its estimate
    // requirements and readings without a second request.
    expect(page.sessions[0]!.estimateRequirements.length).toBeGreaterThan(0);
  });

  it('pages with limit and before, and says when there may be more', async () => {
    const first = sessionHistorySchema.parse(await json(await history('?limit=4')));
    expect(first.sessions.map((s) => s.localDate)).toEqual([
      '2026-08-10',
      '2026-08-09',
      '2026-08-08',
      '2026-08-07',
    ]);
    expect(first.total).toBe(10);
    expect(first.nextCursor).toBe('2026-08-07T06:30:00.000Z');

    const second = sessionHistorySchema.parse(
      await json(await history(`?limit=4&before=${encodeURIComponent(first.nextCursor!)}`)),
    );
    expect(second.sessions.map((s) => s.localDate)).toEqual([
      '2026-08-06',
      '2026-08-05',
      '2026-08-04',
      '2026-08-03',
    ]);
    expect(second.nextCursor).toBe('2026-08-03T06:30:00.000Z');

    const third = sessionHistorySchema.parse(
      await json(await history(`?limit=4&before=${encodeURIComponent(second.nextCursor!)}`)),
    );
    expect(third.sessions.map((s) => s.localDate)).toEqual(['2026-08-02', '2026-08-01']);
    expect(third.nextCursor).toBeUndefined();
  });

  it('narrows to an inclusive local-date range, with the total for that range', async () => {
    const page = sessionHistorySchema.parse(
      await json(await history('?from=2026-08-03&to=2026-08-05')),
    );
    expect(page.sessions.map((s) => s.localDate)).toEqual([
      '2026-08-05',
      '2026-08-04',
      '2026-08-03',
    ]);
    expect(page.total).toBe(3);

    const open = sessionHistorySchema.parse(await json(await history('?from=2026-08-09')));
    expect(page.total).toBe(3);
    expect(open.sessions.map((s) => s.localDate)).toEqual(['2026-08-10', '2026-08-09']);
  });

  it('rejects a malformed query', async () => {
    expect((await history('?limit=0')).status).toBe(400);
    expect((await history('?limit=abc')).status).toBe(400);
    expect((await history('?from=yesterday')).status).toBe(400);
    expect((await history('?before=not-a-time')).status).toBe(400);
    // The cap is enforced rather than silently exceeded.
    expect((await history('?limit=101')).status).toBe(400);
  });

  it("never lists another athlete's sessions", async () => {
    const other = await signUp('other-history@example.com');
    const page = sessionHistorySchema.parse(await json(await history('', other.token)));
    expect(page.sessions).toEqual([]);
    expect(page.total).toBe(0);
  });
});
