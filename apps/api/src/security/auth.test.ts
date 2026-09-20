/**
 * Token revocation.
 *
 * A signature that verifies proves a token was minted here. It says nothing
 * about whether the athlete has since signed out, or whether the profile it
 * names still exists. These run the real stack against embedded Postgres to
 * check that both questions are actually asked, on the routes where the answer
 * matters most: the ones that serve body composition data.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';

import { loadEnv, setEnvForTesting } from '../env.js';
import { getDb, resetDbForTesting, type Database } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { resetProviderRegistry } from '../providers/registry.js';
import { athleteProfiles, users } from '../db/schema.js';
import { issueToken, issuedAtMs, verifyToken } from './auth.js';

const DATA_DIR = 'memory://running-os-auth-revocation';

let app: Hono;
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
      AI_API_KEY: '',
    }),
  );

  resetDbForTesting();
  resetProviderRegistry();

  const handle = await getDb({ dataDir: DATA_DIR });
  await runMigrations({ dataDir: DATA_DIR });
  db = handle.db;

  const { createApp } = await import('../app.js');
  app = createApp();
}, 120_000);

afterAll(async () => {
  const handle = await getDb({ dataDir: DATA_DIR });
  await handle.close();
  setEnvForTesting(undefined);
});

interface Account {
  token: string;
  email: string;
  password: string;
  userId: string;
}

let accountCounter = 0;

async function signUp(): Promise<Account> {
  const email = `revocation-${(accountCounter += 1)}@example.test`;
  const password = 'a-long-enough-password';

  const response = await app.request('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, displayName: 'Revocation Tester' }),
  });
  expect(response.status).toBe(200);

  const body = (await response.json()) as { token: string; user: { id: string } };
  return { token: body.token, email, password, userId: body.user.id };
}

async function signIn(account: Account): Promise<string> {
  const response = await app.request('/api/auth/signin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

const authed = (token: string) => ({ authorization: `Bearer ${token}` });

const sessions = async (token: string): Promise<Response> =>
  app.request('/api/composition/sessions', { headers: authed(token) });

const signOut = async (token: string): Promise<Response> =>
  app.request('/api/auth/signout', { method: 'POST', headers: authed(token) });

describe('POST /api/auth/signout', () => {
  it('requires a token of its own', async () => {
    const response = await app.request('/api/auth/signout', { method: 'POST' });
    expect(response.status).toBe(401);
  });

  it('reports when the account was signed out', async () => {
    const account = await signUp();
    const before = Date.now();

    const response = await signOut(account.token);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { signedOutAt: string };
    const at = new Date(body.signedOutAt).getTime();
    expect(at).toBeGreaterThanOrEqual(before - 1_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it('closes the composition API to the token that was used', async () => {
    const account = await signUp();
    expect((await sessions(account.token)).status).toBe(200);

    await signOut(account.token);

    // The point of the whole exercise: the token is still unexpired and still
    // correctly signed, and it is refused anyway.
    expect(verifyToken(account.token)).toBeDefined();
    expect((await sessions(account.token)).status).toBe(401);
  });

  it('closes every token the account holds, not only the one presented', async () => {
    const account = await signUp();
    const second = await signIn(account);

    expect((await sessions(account.token)).status).toBe(200);
    expect((await sessions(second)).status).toBe(200);

    // Signing out of the phone being handed on has to end the tablet too.
    // There is nothing in a bearer token that distinguishes the two.
    await signOut(second);

    expect((await sessions(account.token)).status).toBe(401);
    expect((await sessions(second)).status).toBe(401);
  });

  it('cannot be replayed with the token it already revoked', async () => {
    const account = await signUp();
    await signOut(account.token);
    expect((await signOut(account.token)).status).toBe(401);
  });

  it('leaves other athletes signed in', async () => {
    const mine = await signUp();
    const theirs = await signUp();

    await signOut(mine.token);

    expect((await sessions(mine.token)).status).toBe(401);
    expect((await sessions(theirs.token)).status).toBe(200);
  });

  it('gives a token that works again on the next sign-in', async () => {
    const account = await signUp();
    await signOut(account.token);

    const fresh = await signIn(account);
    expect((await sessions(fresh)).status).toBe(200);
  });

  it('accepts a token minted in the same second as the revocation', async () => {
    // The regression this guards: revocation stores a millisecond instant and
    // `iat` is only accurate to the second, so comparing the two would refuse
    // a token minted later in the same second as the sign-out — locking an
    // athlete out of their own account for tapping sign-in too quickly.
    //
    // Both instants are pinned rather than raced for. Signing out and straight
    // back in usually lands inside one second, but "usually" is not a test.
    const account = await signUp();
    const [profile] = await db
      .select()
      .from(athleteProfiles)
      .where(eq(athleteProfiles.userId, account.userId))
      .limit(1);

    // Anchored to the current second so the tokens are genuinely unexpired;
    // only the offsets within that second matter to what is being tested.
    const second = Math.floor(Date.now() / 1000) * 1000;
    const at = (ms: number): Date => new Date(second + ms);

    const revokedAt = at(250);
    await db
      .update(users)
      .set({ tokensValidFrom: revokedAt })
      .where(eq(users.id, account.userId));

    const mint = (ms: number): string =>
      issueToken({
        userId: account.userId,
        athleteId: profile!.id,
        email: account.email,
        now: at(ms),
      }).token;

    const before = mint(100);
    const after = mint(900);

    // Same `iat` to the second. Only the millisecond claim tells them apart.
    expect(verifyToken(before)!.iat).toBe(verifyToken(after)!.iat);
    expect(issuedAtMs(verifyToken(before)!)).toBeLessThan(revokedAt.getTime());
    expect(issuedAtMs(verifyToken(after)!)).toBeGreaterThan(revokedAt.getTime());

    expect((await sessions(before)).status).toBe(401);
    expect((await sessions(after)).status).toBe(200);
  });

  it('gives a token that works again on the next sign-in, at real timings', async () => {
    const account = await signUp();
    await signOut(account.token);
    expect((await sessions(await signIn(account))).status).toBe(200);
  });

  it('does not delete anything', async () => {
    const account = await signUp();
    await signOut(account.token);

    // Signing out withdraws access; it is not the delete-my-data button. The
    // athlete's rows are still there and come back on the next sign-in.
    const [profile] = await db
      .select()
      .from(athleteProfiles)
      .where(eq(athleteProfiles.userId, account.userId))
      .limit(1);
    expect(profile).toBeDefined();

    const fresh = await signIn(account);
    const response = await sessions(fresh);
    expect(response.status).toBe(200);
  });
});

describe('requireAuth', () => {
  it('refuses a token whose athlete profile has been deleted', async () => {
    const account = await signUp();
    expect((await sessions(account.token)).status).toBe(200);

    await db.delete(users).where(eq(users.id, account.userId));

    // The signature still verifies and the expiry is a month away. Without the
    // lookup, this token would keep naming an athlete id that no longer exists
    // — and would start naming somebody else's data if the id were ever reused.
    expect(verifyToken(account.token)).toBeDefined();
    expect((await sessions(account.token)).status).toBe(401);
  });

  it('refuses a token that claims an athlete belonging to another user', async () => {
    const mine = await signUp();
    const theirs = await signUp();

    const [theirProfile] = await db
      .select()
      .from(athleteProfiles)
      .where(eq(athleteProfiles.userId, theirs.userId))
      .limit(1);

    // Signed by this server with a real user and a real athlete id — just not
    // ones that go together.
    const forged = issueToken({
      userId: mine.userId,
      athleteId: theirProfile!.id,
      email: mine.email,
    }).token;

    expect(verifyToken(forged)).toBeDefined();
    expect((await app.request('/api/composition/sessions', { headers: authed(forged) })).status).toBe(
      401,
    );
  });

  it('says the same thing whether a token is expired, revoked or orphaned', async () => {
    const account = await signUp();
    await signOut(account.token);

    const expired = issueToken({
      userId: account.userId,
      athleteId: account.userId,
      email: account.email,
      now: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
    }).token;

    const revokedBody = (await sessions(account.token)).json();
    const expiredBody = (await sessions(expired)).json();

    // Telling the holder of a token which of the three it is would say
    // something about the account to someone who does not have access to it.
    expect((await revokedBody) as unknown).toEqual((await expiredBody) as unknown);
  });
});

describe('issueToken', () => {
  it('records issuance in milliseconds as well as seconds', async () => {
    const now = new Date('2026-03-01T10:00:00.750Z');
    const { token } = issueToken({
      userId: 'a',
      athleteId: 'b',
      email: 'c@example.test',
      now,
    });

    const payload = verifyToken(token, now)!;
    expect(payload.iat).toBe(Math.floor(now.getTime() / 1000));
    expect(issuedAtMs(payload)).toBe(now.getTime());
  });

  it('falls back to the second-accurate claim for tokens minted without it', () => {
    // Tokens issued before `iatMs` existed are still in athletes' keychains
    // for up to thirty days, and have to keep working.
    expect(issuedAtMs({ sub: 'a', athleteId: 'b', email: 'c', iat: 1_700_000_000, exp: 0 })).toBe(
      1_700_000_000_000,
    );
  });
});
