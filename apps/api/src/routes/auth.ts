/**
 * Authentication routes.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { signInSchema, signUpSchema, API_ERROR_CODES } from '@running/contracts';
import { getDb } from '../db/client.js';
import { athleteProfiles, auditLogs, users } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../security/crypto.js';
import { issueToken } from '../security/auth.js';
import { ApiError, badRequest } from '../errors.js';
import { logger } from '../observability/logger.js';

export const authRoutes = new Hono();

const DEFAULT_AVAILABILITY = {
  runDays: [1, 2, 4, 6, 0],
  longRunDay: 0,
  restDays: [3, 5],
  strengthDays: [],
  crossTrainingDays: [],
  maxSessionsPerWeek: 5,
};

const DEFAULT_CONSTRAINTS = {
  activePain: false,
  hasTreadmillAccess: false,
  hasTrackAccess: false,
  hasGymAccess: false,
  surfacePreference: 'road',
  unavailableDates: [],
};

const DEFAULT_NOTIFICATIONS = {
  dailyWorkout: true,
  morningCheckIn: true,
  weeklyReview: true,
  planAdjustments: true,
  syncFailures: true,
};

authRoutes.post('/signup', async (c) => {
  const parsed = signUpSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw badRequest('Check the details you entered.', {
      issues: parsed.error.issues.map((i) => i.message),
    });
  }

  const { db } = await getDb();
  const email = parsed.data.email.toLowerCase().trim();

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    // Deliberately generic: this endpoint must not confirm which addresses
    // are registered.
    throw new ApiError(409, API_ERROR_CODES.CONFLICT, 'That email cannot be used to sign up.');
  }

  const [user] = await db
    .insert(users)
    .values({
      email,
      passwordHash: hashPassword(parsed.data.password),
      displayName: parsed.data.displayName,
    })
    .returning();

  const [athlete] = await db
    .insert(athleteProfiles)
    .values({
      userId: user!.id,
      displayName: parsed.data.displayName,
      background: {},
      availability: DEFAULT_AVAILABILITY,
      constraints: DEFAULT_CONSTRAINTS,
      notifications: DEFAULT_NOTIFICATIONS,
    })
    .returning();

  const { token, expiresAt } = issueToken({
    userId: user!.id,
    athleteId: athlete!.id,
    email,
  });

  await db.insert(auditLogs).values({
    userId: user!.id,
    athleteId: athlete!.id,
    action: 'user.signup',
    resource: 'user',
  });

  logger.info('auth.signup', { userId: user!.id });

  return c.json({
    token,
    expiresAt: expiresAt.toISOString(),
    user: { id: user!.id, email, displayName: user!.displayName },
    hasCompletedOnboarding: false,
  });
});

authRoutes.post('/signin', async (c) => {
  const parsed = signInSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw badRequest('Enter your email and password.');

  const { db } = await getDb();
  const email = parsed.data.email.toLowerCase().trim();

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  // Verify against a dummy hash when the user is absent, so a missing account
  // and a wrong password take the same amount of time.
  const passwordOk = user
    ? verifyPassword(parsed.data.password, user.passwordHash)
    : verifyPassword(parsed.data.password, hashPassword('placeholder-for-timing'));

  if (!user || !passwordOk) {
    throw new ApiError(401, API_ERROR_CODES.UNAUTHORIZED, 'Email or password is incorrect.');
  }

  const [athlete] = await db
    .select()
    .from(athleteProfiles)
    .where(eq(athleteProfiles.userId, user.id))
    .limit(1);

  if (!athlete) {
    throw new ApiError(500, API_ERROR_CODES.INTERNAL, 'Your account is missing an athlete profile.');
  }

  const { token, expiresAt } = issueToken({
    userId: user.id,
    athleteId: athlete.id,
    email: user.email,
  });

  logger.info('auth.signin', { userId: user.id });

  return c.json({
    token,
    expiresAt: expiresAt.toISOString(),
    user: { id: user.id, email: user.email, displayName: user.displayName },
    hasCompletedOnboarding: athlete.hasCompletedOnboarding,
  });
});
