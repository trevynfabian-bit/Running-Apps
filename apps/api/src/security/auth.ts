/**
 * Authentication: JWT issuance/verification and the auth middleware.
 *
 * A small hand-rolled HS256 implementation rather than a dependency: the
 * surface we need is one signing algorithm and one verification path, and
 * keeping it here makes the security-relevant code auditable in one screen.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';

import { env } from '../env.js';
import { API_ERROR_CODES } from '@running/contracts';
import { getDb } from '../db/client.js';
import { athleteProfiles, users } from '../db/schema.js';
import { ApiError } from '../errors.js';

export interface TokenPayload {
  /** User id. */
  sub: string;
  athleteId: string;
  email: string;
  /** Issued-at and expiry, seconds since epoch. */
  iat: number;
  exp: number;
  /**
   * Issued-at in milliseconds.
   *
   * Not a registered JWT claim, and present for one reason: revocation
   * compares a token's issuance against a stored instant, and `iat` is only
   * accurate to the second. With seconds alone, signing out at 10:00:00.5 and
   * signing straight back in at 10:00:00.9 mints a token that looks older than
   * the sign-out and is refused, so the athlete cannot get back in. Tokens
   * minted before this claim existed fall back to `iat`.
   */
  iatMs?: number;
}

const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function signingKey(): string {
  const secret = env().AUTH_JWT_SECRET;
  if (secret && secret.length >= 32) return secret;
  // `loadEnv` blocks production without a real secret, so this only ever
  // applies to local development.
  return 'running-os-development-jwt-secret-not-for-production-use';
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string): string {
  return createHmac('sha256', signingKey()).update(data).digest('base64url');
}

export function issueToken(args: {
  userId: string;
  athleteId: string;
  email: string;
  now?: Date;
}): { token: string; expiresAt: Date } {
  const issuedAtMs = (args.now ?? new Date()).getTime();
  const issuedAt = Math.floor(issuedAtMs / 1000);
  const expiresAt = issuedAt + TOKEN_TTL_SECONDS;

  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      sub: args.userId,
      athleteId: args.athleteId,
      email: args.email,
      iat: issuedAt,
      exp: expiresAt,
      iatMs: issuedAtMs,
    } satisfies TokenPayload),
  );

  const signature = sign(`${header}.${payload}`);
  return { token: `${header}.${payload}.${signature}`, expiresAt: new Date(expiresAt * 1000) };
}

/**
 * Verify a token. Returns undefined for anything invalid — malformed,
 * wrong signature, expired, or using an unexpected algorithm.
 */
export function verifyToken(token: string, now: Date = new Date()): TokenPayload | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;

  const [header, payload, signature] = parts as [string, string, string];

  const expected = sign(`${header}.${payload}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;

  let decodedHeader: { alg?: string };
  let decoded: TokenPayload;
  try {
    decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }

  // Reject algorithm confusion outright rather than trusting the header.
  if (decodedHeader.alg !== 'HS256') return undefined;

  if (typeof decoded.exp !== 'number' || decoded.exp * 1000 <= now.getTime()) return undefined;
  if (!decoded.sub || !decoded.athleteId) return undefined;

  return decoded;
}

/** Hono context variables set by `requireAuth`. */
export interface AuthVariables {
  userId: string;
  athleteId: string;
  email: string;
}

/** Milliseconds a token was issued at, from whichever claim carries it. */
export function issuedAtMs(payload: TokenPayload): number {
  return payload.iatMs ?? payload.iat * 1000;
}

/**
 * Is this token still one the account stands behind?
 *
 * A signature that verifies only proves the token was minted here. It says
 * nothing about whether the athlete has since signed out, or whether the
 * profile the token names still exists — and both matter more for body
 * photographs than for a training plan. So the middleware asks the database
 * two questions on every authenticated request:
 *
 *  - has the account moved `tokensValidFrom` past this token's issuance?
 *  - does the athlete profile in the token still exist, still owned by the
 *    user in the token?
 *
 * It is one indexed lookup by primary key, on requests that were about to
 * query the database anyway. Paying it means a sign-out actually ends access
 * rather than ending it thirty days later when the token expires.
 */
async function tokenStillHonoured(payload: TokenPayload): Promise<boolean> {
  const { db } = await getDb();

  const [row] = await db
    .select({ tokensValidFrom: users.tokensValidFrom, userId: athleteProfiles.userId })
    .from(athleteProfiles)
    .innerJoin(users, eq(users.id, athleteProfiles.userId))
    .where(eq(athleteProfiles.id, payload.athleteId))
    .limit(1);

  // The profile was deleted, or the token names a profile that belongs to
  // somebody else. Either way this token no longer stands for anything.
  if (!row || row.userId !== payload.sub) return false;

  return issuedAtMs(payload) >= row.tokensValidFrom.getTime();
}

export function requireAuth() {
  return async (c: Context<{ Variables: AuthVariables }>, next: Next): Promise<void> => {
    const header = c.req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      throw new ApiError(401, API_ERROR_CODES.UNAUTHORIZED, 'Sign in to continue.');
    }

    const payload = verifyToken(header.slice('Bearer '.length).trim());
    if (!payload) {
      throw new ApiError(401, API_ERROR_CODES.UNAUTHORIZED, 'Your session has expired. Sign in again.');
    }

    // Same message and status as an expired token. A revoked token and a
    // deleted profile are not distinguished for the caller: the useful thing
    // to tell someone holding either is to sign in again.
    if (!(await tokenStillHonoured(payload))) {
      throw new ApiError(401, API_ERROR_CODES.UNAUTHORIZED, 'Your session has expired. Sign in again.');
    }

    c.set('userId', payload.sub);
    c.set('athleteId', payload.athleteId);
    c.set('email', payload.email);
    await next();
  };
}
