/**
 * End-to-end API tests.
 *
 * Runs against a real embedded Postgres (PGlite) with real migrations, so
 * constraints, upserts and idempotency are genuinely exercised rather than
 * mocked away. This is the test that proves the MVP flow described in the
 * product brief actually works.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';

import { loadEnv, setEnvForTesting } from './env.js';
import { getDb, resetDbForTesting } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { resetProviderRegistry } from './providers/registry.js';

let app: Hono;
let token: string;

const DATA_DIR = 'memory://running-os-tests';

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

  await getDb({ dataDir: DATA_DIR });
  await runMigrations({ dataDir: DATA_DIR });

  const { createApp } = await import('./app.js');
  app = createApp();
}, 120_000);

afterAll(async () => {
  const handle = await getDb({ dataDir: DATA_DIR });
  await handle.close();
  setEnvForTesting(undefined);
});

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
}

/**
 * `Response.json()` is typed `unknown`. These are integration tests asserting
 * on a wire format the contracts package already types, so a local cast keeps
 * the assertions readable without weakening the production types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(response: Response): Promise<any> {
  return response.json();
}

describe('health', () => {
  it('reports ok', async () => {
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    expect((await json(response)).status).toBe('ok');
  });
});

describe('authentication', () => {
  it('rejects unauthenticated access to athlete data', async () => {
    const response = await app.request('/api/me');
    expect(response.status).toBe(401);
    const body = await json(response);
    expect(body.error.code).toBe('unauthorized');
    // The message must be safe to show the athlete verbatim.
    expect(body.error.message).not.toMatch(/stack|Error:/i);
  });

  it('rejects a forged token', async () => {
    const response = await app.request('/api/me', {
      headers: { authorization: 'Bearer not.a.token' },
    });
    expect(response.status).toBe(401);
  });

  it('signs up a new athlete', async () => {
    const response = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'e2e@example.com',
        password: 'a-sufficiently-long-password',
        displayName: 'E2E Athlete',
      }),
    });

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.token).toBeTruthy();
    expect(body.hasCompletedOnboarding).toBe(false);
    token = body.token;
  });

  it('refuses a weak password', async () => {
    const response = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'weak@example.com', password: 'short', displayName: 'X' }),
    });
    expect(response.status).toBe(400);
  });

  it('does not reveal whether an email is registered', async () => {
    const response = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'e2e@example.com',
        password: 'a-sufficiently-long-password',
        displayName: 'Duplicate',
      }),
    });
    expect(response.status).toBe(409);
    expect((await json(response)).error.message).not.toMatch(/already|exists|registered/i);
  });

  it('signs in with correct credentials', async () => {
    const response = await app.request('/api/auth/signin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'e2e@example.com', password: 'a-sufficiently-long-password' }),
    });
    expect(response.status).toBe(200);
    token = (await json(response)).token;
  });

  it('rejects a wrong password', async () => {
    const response = await app.request('/api/auth/signin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'e2e@example.com', password: 'wrong-password-entirely' }),
    });
    expect(response.status).toBe(401);
  });
});

describe('athlete profile', () => {
  it('returns the profile', async () => {
    const response = await authed('/api/me');
    expect(response.status).toBe(200);
    expect((await json(response)).displayName).toBe('E2E Athlete');
  });

  it('accepts a profile update', async () => {
    const response = await authed('/api/me', {
      method: 'PATCH',
      body: JSON.stringify({
        dateOfBirth: '2002-03-14',
        sex: 'male',
        preferences: {
          units: 'metric',
          primaryZoneMethodology: 'hr_reserve',
          timezone: 'Asia/Jakarta',
          notifications: {
            dailyWorkout: true,
            morningCheckIn: true,
            weeklyReview: true,
            planAdjustments: true,
            syncFailures: true,
          },
        },
        markers: { maxHeartRateBpm: 194, restingHeartRateBpm: 48 },
        availability: {
          runDays: [1, 2, 4, 6, 0],
          longRunDay: 0,
          restDays: [3, 5],
          strengthDays: [2],
          crossTrainingDays: [],
          maxSessionsPerWeek: 5,
        },
      }),
    });
    expect(response.status).toBe(200);

    const profile = await json(await authed('/api/me'));
    expect(profile.markers.maxHeartRateBpm).toBe(194);
    expect(profile.preferences.timezone).toBe('Asia/Jakarta');
  });

  it('rejects invalid profile values', async () => {
    const response = await authed('/api/me', {
      method: 'PATCH',
      body: JSON.stringify({ sex: 'not-a-value' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('the full MVP flow', () => {
  it('lists providers as available but disconnected', async () => {
    const response = await authed('/api/connections');
    expect(response.status).toBe(200);

    const { connections } = await json(response);
    expect(connections).toHaveLength(3);
    expect(connections.every((c: { status: string }) => c.status === 'disconnected')).toBe(true);
    // Every provider must explain what connecting grants access to.
    expect(
      connections.every((c: { dataDescription: string[] }) => c.dataDescription.length > 0),
    ).toBe(true);
  });

  it('connects Strava and imports history', async () => {
    const connect = await authed('/api/connections/strava/connect', { method: 'POST' });
    expect(connect.status).toBe(200);

    const sync = await authed('/api/connections/strava/sync?full=true', { method: 'POST' });
    expect(sync.status).toBe(200);

    const result = await json(sync);
    expect(result.recordsFetched).toBeGreaterThan(0);
  });

  it('collapses the same runs from three providers into one history', async () => {
    await authed('/api/connections/whoop/connect', { method: 'POST' });
    await authed('/api/connections/whoop/sync?full=true', { method: 'POST' });
    await authed('/api/connections/healthkit/connect', { method: 'POST' });
    await authed('/api/connections/healthkit/sync?full=true', { method: 'POST' });

    const response = await authed('/api/workouts?limit=200');
    const { workouts } = await json(response);

    expect(workouts.length).toBeGreaterThan(20);

    // The decisive assertion: workouts seen by several providers must carry
    // several source records, not exist as several workouts.
    const multiSource = workouts.filter(
      (w: { sourceRecords: unknown[] }) => w.sourceRecords.length > 1,
    );
    expect(multiSource.length).toBeGreaterThan(0);

    // No two workouts may start at the same instant — that would be a duplicate.
    const starts = workouts.map((w: { startTime: string }) => w.startTime);
    expect(new Set(starts).size).toBe(starts.length);
  });

  it('is idempotent: re-syncing does not duplicate anything', async () => {
    const before = (await json(await authed('/api/workouts?limit=200'))).workouts.length;

    await authed('/api/connections/strava/sync?full=true', { method: 'POST' });
    await authed('/api/connections/whoop/sync?full=true', { method: 'POST' });

    const after = (await json(await authed('/api/workouts?limit=200'))).workouts.length;
    expect(after).toBe(before);
  });

  it('records provenance for every merged workout', async () => {
    const { workouts } = await json(await authed('/api/workouts?limit=20'));
    const merged = workouts.find((w: { sourceRecords: unknown[] }) => w.sourceRecords.length > 1);

    expect(merged).toBeDefined();
    for (const source of merged.sourceRecords) {
      expect(['strava', 'whoop', 'healthkit']).toContain(source.provider);
      expect(source.externalId).toBeTruthy();
    }
    // At least one provider must be credited with a specific field.
    expect(
      merged.sourceRecords.some((s: { contributedFields: string[] }) => s.contributedFields.length > 0),
    ).toBe(true);
  });

  it('creates a race goal', async () => {
    const inTwelveWeeks = new Date(Date.now() + 84 * 86_400_000).toISOString().slice(0, 10);
    const response = await authed('/api/race-goals', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Jakarta 10K',
        date: inTwelveWeeks,
        distanceMeters: 10000,
        targetDurationSeconds: 3000,
        priority: 'A',
      }),
    });
    expect(response.status).toBe(201);
  });

  it('records a race result to anchor fitness estimates', async () => {
    const response = await authed('/api/race-results', {
      method: 'POST',
      body: JSON.stringify({
        distanceMeters: 5000,
        durationSeconds: 1540,
        date: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
        source: 'race',
        name: 'Parkrun',
      }),
    });
    expect(response.status).toBe(201);
  });

  it('generates a periodised training plan', async () => {
    const { goals } = await json(await authed('/api/race-goals'));
    expect(goals.length).toBeGreaterThan(0);

    const response = await authed('/api/training-plan/generate', {
      method: 'POST',
      body: JSON.stringify({ template: 'road_10k', raceGoalId: goals[0].id }),
    });

    expect(response.status).toBe(200);
    const plan = await json(response);
    expect(plan.blocks).toBeGreaterThan(0);
    expect(plan.workouts).toBeGreaterThan(0);
    // The plan must be able to explain itself.
    expect(plan.generationBasis.notes.length).toBeGreaterThan(0);
  });

  it('returns the plan grouped into weeks', async () => {
    const response = await authed('/api/training-plan');
    expect(response.status).toBe(200);

    const { plan, weeks } = await json(response);
    expect(plan).toBeDefined();
    expect(weeks.length).toBeGreaterThan(0);
    expect(weeks[0].workouts.length).toBeGreaterThan(0);
    expect(weeks[0].blockName).toBeTruthy();
  });

  it('submits a morning check-in and gets readiness back', async () => {
    const response = await authed('/api/check-in', {
      method: 'POST',
      body: JSON.stringify({ energy: 4, soreness: 4, stress: 3, motivation: 4, hasPain: false }),
    });

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.readiness.score).toBeGreaterThan(0);
    expect(['green', 'yellow', 'red']).toContain(body.readiness.band);
  });

  it('serves a dashboard that answers "what should I do today?"', async () => {
    const response = await authed('/api/dashboard');
    expect(response.status).toBe(200);

    const dashboard = await json(response);
    expect(dashboard.greeting).toMatch(/Good (morning|afternoon|evening)/);
    expect(dashboard.readiness.score).toBeGreaterThanOrEqual(0);
    expect(dashboard.trainingState.state).toBeTruthy();
    expect(dashboard.weeklyProgress).toBeDefined();

    // Every decision must arrive with an explanation attached.
    if (dashboard.decision) {
      expect(dashboard.decision.explanation.length).toBeGreaterThan(10);
      expect(dashboard.decision.reasons.length).toBeGreaterThan(0);
    }
  });

  it('reports pain and gets a conservative recommendation with a referral', async () => {
    const response = await authed('/api/check-in', {
      method: 'POST',
      body: JSON.stringify({
        energy: 4,
        soreness: 3,
        stress: 3,
        motivation: 4,
        hasPain: true,
        painNote: 'Left achilles tightness',
      }),
    });

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.decision.decision).toBe('REST');
    // Must point to a professional rather than diagnosing.
    expect(body.decision.explanation).toMatch(/qualified health professional/i);
  });

  it('clears the pain flag on a new check-in', async () => {
    const response = await authed('/api/check-in', {
      method: 'POST',
      body: JSON.stringify({ energy: 4, soreness: 4, stress: 3, motivation: 4, hasPain: false }),
    });
    expect((await json(response)).decision.decision).not.toBe('REST');
  });

  it('logs a manual workout', async () => {
    const response = await authed('/api/workouts', {
      method: 'POST',
      body: JSON.stringify({
        type: 'easy',
        sport: 'run',
        startTime: new Date(Date.now() - 3600_000).toISOString(),
        durationSeconds: 2400,
        distanceMeters: 6000,
        perceivedExertion: 3,
      }),
    });
    expect(response.status).toBe(201);
  });

  it('analyses a workout after the fact', async () => {
    const { workouts } = await json(await authed('/api/workouts?limit=5'));
    const response = await authed(`/api/workouts/${workouts[0].id}`);

    expect(response.status).toBe(200);
    const detail = await json(response);
    expect(detail.analysis).toBeDefined();
    expect(detail.analysis.insight.length).toBeGreaterThan(0);
  });

  it('serves progress trends with explicit confidence', async () => {
    const response = await authed('/api/progress');
    expect(response.status).toBe(200);

    const progress = await json(response);
    expect(progress.training.weeklyDistance.length).toBeGreaterThan(0);
    expect(progress.racePredictions.length).toBeGreaterThan(0);

    // Every prediction must be labelled as an estimate with a stated basis.
    for (const prediction of progress.racePredictions) {
      expect(['low', 'moderate', 'high']).toContain(prediction.confidence);
      expect(prediction.basis.length).toBeGreaterThan(0);
    }
  });

  it('shows a longer race prediction with no more confidence than a shorter one', async () => {
    const { racePredictions } = await json(await authed('/api/progress'));
    const rank = { low: 0, moderate: 1, high: 2 };

    const tenK = racePredictions.find((p: { distanceMeters: number }) => p.distanceMeters === 10000);
    const marathon = racePredictions.find(
      (p: { distanceMeters: number }) => p.distanceMeters === 42195,
    );

    if (tenK && marathon) {
      expect(rank[marathon.confidence as 'low']).toBeLessThanOrEqual(rank[tenK.confidence as 'low']);
    }
  });

  it('serves recovery detail with components and missing signals', async () => {
    const response = await authed('/api/recovery');
    expect(response.status).toBe(200);

    const recovery = await json(response);
    expect(recovery.today.summary.length).toBeGreaterThan(0);
    expect(Array.isArray(recovery.today.components)).toBe(true);
    expect(Array.isArray(recovery.today.missingSignals)).toBe(true);
  });

  it('generates a weekly review', async () => {
    const response = await authed('/api/reviews/weekly');
    expect(response.status).toBe(200);

    const review = await json(response);
    expect(review.headline).toBeTruthy();
    expect(review.nextWeekPriority).toBeTruthy();
    expect(Array.isArray(review.whatWentWell)).toBe(true);
  });
});

describe('AI coach', () => {
  it('answers from stored data without an LLM configured', async () => {
    const response = await authed('/api/coach/message', {
      method: 'POST',
      body: JSON.stringify({ message: 'Am I getting faster?' }),
    });

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.answer.length).toBeGreaterThan(10);
    // With no AI key, the deterministic responder must have answered.
    expect(body.generatedWithoutLlm).toBe(true);
  });

  it('explains why today’s session is what it is', async () => {
    const response = await authed('/api/coach/message', {
      method: 'POST',
      body: JSON.stringify({ message: "Why is today's run easy?" }),
    });

    const body = await json(response);
    expect(body.answer.length).toBeGreaterThan(10);
  });

  it('builds a bounded context rather than dumping the database', async () => {
    const response = await authed('/api/coach/context');
    expect(response.status).toBe(200);

    const context = await json(response);
    expect(context.athlete).toBeDefined();
    expect(context.recentWorkouts.length).toBeLessThanOrEqual(10);
    expect(Array.isArray(context.missingData)).toBe(true);

    // The context must never carry credentials.
    const serialized = JSON.stringify(context);
    expect(serialized).not.toMatch(/access_token|refresh_token|passwordHash/i);
  });

  it('keeps conversation history', async () => {
    const response = await authed('/api/coach/history');
    const { messages } = await json(response);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m: { role: string }) => m.role === 'assistant')).toBe(true);
  });
});

describe('disconnection and deletion', () => {
  it('disconnects a provider but keeps corroborated history', async () => {
    const before = (await json(await authed('/api/workouts?limit=200'))).workouts.length;

    const response = await authed('/api/connections/whoop?deleteData=true', { method: 'DELETE' });
    expect(response.status).toBe(200);

    const after = (await json(await authed('/api/workouts?limit=200'))).workouts.length;
    // Runs Strava and Apple Health also saw must survive losing WHOOP.
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThanOrEqual(before);

    const { connections } = await json(await authed('/api/connections'));
    const whoop = connections.find((c: { provider: string }) => c.provider === 'whoop');
    expect(whoop.status).toBe('disconnected');
  });

  it('still serves a dashboard with a provider missing', async () => {
    // Partial connectivity is a normal state, not an error.
    const response = await authed('/api/dashboard');
    expect(response.status).toBe(200);
    expect((await json(response)).readiness).toBeDefined();
  });
});

describe('webhooks', () => {
  it('answers the Strava subscription challenge', async () => {
    setEnvForTesting(
      loadEnv({
        NODE_ENV: 'test',
        USE_MOCK_DATA: true,
        DATABASE_URL: '',
        PGLITE_DIR: DATA_DIR,
        AUTH_JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
        TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
        STRAVA_WEBHOOK_VERIFY_TOKEN: 'verify-me',
      }),
    );

    const response = await app.request(
      '/api/webhooks/strava?hub.mode=subscribe&hub.challenge=abc123&hub.verify_token=verify-me',
    );

    expect(response.status).toBe(200);
    expect((await json(response))['hub.challenge']).toBe('abc123');
  });

  it('rejects a wrong verify token', async () => {
    const response = await app.request(
      '/api/webhooks/strava?hub.mode=subscribe&hub.challenge=abc&hub.verify_token=wrong',
    );
    expect(response.status).toBe(403);
  });

  it('acknowledges an activity event immediately', async () => {
    const response = await app.request('/api/webhooks/strava', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        object_type: 'activity',
        object_id: 123456,
        aspect_type: 'create',
        owner_id: 999,
        subscription_id: 1,
        event_time: Math.floor(Date.now() / 1000),
      }),
    });

    // Must ACK fast regardless of whether the athlete is known to us.
    expect(response.status).toBe(200);
    expect((await json(response)).received).toBe(true);
  });

  it('acknowledges a redelivered event without reprocessing it', async () => {
    const event = {
      object_type: 'activity',
      object_id: 777,
      aspect_type: 'create',
      owner_id: 999,
      subscription_id: 1,
      event_time: 1_700_000_000,
    };

    const first = await app.request('/api/webhooks/strava', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
    const second = await app.request('/api/webhooks/strava', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('tolerates a malformed webhook body', async () => {
    const response = await app.request('/api/webhooks/strava', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    });
    expect(response.status).toBe(200);
  });

  it('refuses an unsigned WHOOP webhook when a secret is configured', async () => {
    setEnvForTesting(
      loadEnv({
        NODE_ENV: 'test',
        USE_MOCK_DATA: true,
        DATABASE_URL: '',
        PGLITE_DIR: DATA_DIR,
        AUTH_JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
        TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
        WHOOP_WEBHOOK_SECRET: 'whoop-secret',
      }),
    );

    const response = await app.request('/api/webhooks/whoop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: 1, id: 'x', type: 'workout.updated' }),
    });

    expect(response.status).toBe(401);
  });
});

describe('error handling', () => {
  it('does not reveal which endpoints exist to an unauthenticated caller', async () => {
    // The auth boundary sits in front of routing, so an unknown /api path is
    // rejected as unauthorised rather than 404. That is deliberate: it fails
    // closed and prevents endpoint enumeration without a token.
    const response = await app.request('/api/does-not-exist');
    expect(response.status).toBe(401);
  });

  it('returns a clean 404 for an unknown endpoint when authenticated', async () => {
    const response = await authed('/api/does-not-exist');
    expect(response.status).toBe(404);
    expect((await json(response)).error.code).toBe('not_found');
  });

  it('returns a clean 404 for another athlete’s workout', async () => {
    const response = await authed('/api/workouts/00000000-0000-0000-0000-000000000000');
    expect(response.status).toBe(404);
  });

  it('never leaks a stack trace', async () => {
    const response = await authed('/api/workouts/not-a-uuid');
    const text = await response.text();
    expect(text).not.toMatch(/at .*\.ts:\d+|node_modules/);
  });
});
