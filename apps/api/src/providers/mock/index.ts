/**
 * Mock providers for development.
 *
 * With USE_MOCK_DATA=true the whole product runs end to end — onboarding,
 * sync, dedup, coaching, reviews — with no API credentials at all. This is
 * what makes the app developable before a Strava or WHOOP application has been
 * approved, and it keeps tests hermetic.
 *
 * The generated data is deliberately *realistic rather than tidy*:
 *   - the same run appears in more than one provider with slightly different
 *     distance, duration and start time, so the dedup engine is genuinely
 *     exercised rather than trivially satisfied
 *   - some runs have no heart rate
 *   - recovery, HRV and sleep vary with training load rather than randomly
 *
 * Everything is derived from a seeded PRNG, so a given athlete id always
 * produces the same history. Reproducible bugs matter more than novelty.
 */

import type { ProviderWorkout, WorkoutType } from '@running/core';
import type {
  FitnessDataProvider,
  NormalizedBodyMeasurement,
  NormalizedRecovery,
  NormalizedSleep,
  OAuthTokens,
  ProviderCapabilities,
  ProviderSyncPayload,
  SyncWindow,
} from '../types.js';
import { emptyPayload } from '../types.js';

/**
 * Deterministic PRNG (mulberry32). Seeded from the athlete id so each athlete
 * gets a stable but distinct history.
 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** A week of training: type and target distance per weekday (Mon..Sun). */
const WEEK_PATTERN: { type: WorkoutType; km: number }[] = [
  { type: 'easy', km: 6 },
  { type: 'intervals', km: 8 },
  { type: 'rest', km: 0 },
  { type: 'threshold', km: 7 },
  { type: 'rest', km: 0 },
  { type: 'easy', km: 5 },
  { type: 'long', km: 14 },
];

export interface MockHistoryOptions {
  athleteId: string;
  /** How many weeks of history to generate. */
  weeks: number;
  /** Local date the history ends on (usually today). */
  endDate: Date;
  timezone: string;
  /** Fitness improves across the window by this fraction. */
  improvementFactor?: number;
}

interface MockSession {
  start: Date;
  type: WorkoutType;
  distanceMeters: number;
  durationSeconds: number;
  avgHeartRateBpm?: number;
  maxHeartRateBpm?: number;
  elevationGainMeters: number;
  /** Index of the week within the history, for load-dependent recovery. */
  weekIndex: number;
}

/**
 * Generate the underlying "truth" of what the athlete actually did.
 * Each provider then reports a slightly different view of these sessions.
 */
function generateSessions(options: MockHistoryOptions): MockSession[] {
  const rng = makeRng(hashString(options.athleteId));
  const improvement = options.improvementFactor ?? 0.06;
  const sessions: MockSession[] = [];

  const end = new Date(options.endDate);
  end.setUTCHours(0, 0, 0, 0);

  for (let week = 0; week < options.weeks; week++) {
    // Oldest week first.
    const weeksBack = options.weeks - 1 - week;
    const progress = options.weeks <= 1 ? 1 : week / (options.weeks - 1);

    // Every fourth week is a deload.
    const isDeload = (week + 1) % 4 === 0;
    const volumeScale = (0.85 + 0.3 * progress) * (isDeload ? 0.72 : 1);

    for (let day = 0; day < 7; day++) {
      const pattern = WEEK_PATTERN[day]!;
      if (pattern.type === 'rest') continue;

      // Occasionally miss a session — real athletes do.
      if (rng() < 0.08) continue;

      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - weeksBack * 7 - (6 - day));
      // Early-morning runs, 05:30-06:30 local (UTC+7 fixture ⇒ ~22:30-23:30Z).
      start.setUTCHours(22, 30 + Math.floor(rng() * 60), 0, 0);
      start.setUTCDate(start.getUTCDate() - 1);

      const distanceMeters = pattern.km * 1000 * volumeScale * (0.95 + rng() * 0.1);

      // Pace improves over the window; harder sessions are faster.
      const basePace = 390 - improvement * 390 * progress;
      const paceMultiplier =
        pattern.type === 'intervals'
          ? 0.82
          : pattern.type === 'threshold'
            ? 0.88
            : pattern.type === 'long'
              ? 1.04
              : 1;
      const pace = basePace * paceMultiplier * (0.98 + rng() * 0.04);
      const durationSeconds = (distanceMeters / 1000) * pace;

      // ~15% of sessions have no heart rate (strap forgotten, watch glitch).
      const hasHeartRate = rng() > 0.15;
      const baseHr =
        pattern.type === 'intervals'
          ? 168
          : pattern.type === 'threshold'
            ? 162
            : pattern.type === 'long'
              ? 148
              : 143;

      sessions.push({
        start,
        type: pattern.type,
        distanceMeters,
        durationSeconds,
        avgHeartRateBpm: hasHeartRate ? baseHr + Math.round(rng() * 6 - 3) : undefined,
        maxHeartRateBpm: hasHeartRate ? baseHr + 14 + Math.round(rng() * 6) : undefined,
        elevationGainMeters: Math.round((distanceMeters / 1000) * (4 + rng() * 8)),
        weekIndex: week,
      });
    }
  }

  return sessions;
}

/** Strava's view: authoritative distance and GPS, names the session. */
function toStravaWorkout(session: MockSession, athleteId: string, tz: string): ProviderWorkout {
  const names: Partial<Record<WorkoutType, string>> = {
    easy: 'Easy run',
    intervals: 'Interval session',
    threshold: 'Threshold run',
    long: 'Long run',
  };

  return {
    provider: 'strava',
    externalId: `mock-strava-${session.start.getTime()}`,
    athleteId,
    type: session.type,
    sport: 'run',
    name: names[session.type] ?? 'Run',
    startTime: session.start,
    endTime: new Date(session.start.getTime() + session.durationSeconds * 1000),
    timezone: tz,
    durationSeconds: Math.round(session.durationSeconds),
    movingTimeSeconds: Math.round(session.durationSeconds * 0.99),
    distanceMeters: Math.round(session.distanceMeters),
    avgHeartRateBpm: session.avgHeartRateBpm,
    maxHeartRateBpm: session.maxHeartRateBpm,
    elevationGainMeters: session.elevationGainMeters,
    avgCadenceSpm: 168 + Math.round(Math.sin(session.start.getTime()) * 4),
    indoor: false,
    syncedAt: new Date(),
  };
}

/**
 * WHOOP's view: auto-detected, so it starts slightly late and reports a
 * marginally shorter distance. Heart rate is its strong suit.
 */
function toWhoopWorkout(session: MockSession, athleteId: string, tz: string): ProviderWorkout {
  const clipSeconds = 45 + (session.start.getTime() % 90);
  const start = new Date(session.start.getTime() + clipSeconds * 1000);

  return {
    provider: 'whoop',
    externalId: `mock-whoop-${session.start.getTime()}`,
    athleteId,
    type: 'easy', // WHOOP cannot classify the session shape
    sport: 'run',
    name: 'running',
    startTime: start,
    endTime: new Date(session.start.getTime() + session.durationSeconds * 1000),
    timezone: tz,
    durationSeconds: Math.round(session.durationSeconds - clipSeconds),
    distanceMeters: Math.round(session.distanceMeters * 0.994),
    avgHeartRateBpm: session.avgHeartRateBpm ? session.avgHeartRateBpm + 1 : undefined,
    maxHeartRateBpm: session.maxHeartRateBpm,
    calories: Math.round((session.durationSeconds / 60) * 11),
    syncedAt: new Date(),
  };
}

/** Apple Health's view: agrees closely with Strava, slightly different rounding. */
function toHealthKitWorkout(session: MockSession, athleteId: string, tz: string): ProviderWorkout {
  return {
    provider: 'healthkit',
    externalId: `mock-hk-${session.start.getTime()}`,
    athleteId,
    type: session.type,
    sport: 'run',
    startTime: session.start,
    endTime: new Date(session.start.getTime() + (session.durationSeconds + 1) * 1000),
    timezone: tz,
    durationSeconds: Math.round(session.durationSeconds) + 1,
    distanceMeters: Math.round(session.distanceMeters * 0.9986),
    avgHeartRateBpm: session.avgHeartRateBpm ? session.avgHeartRateBpm - 1 : undefined,
    maxHeartRateBpm: session.maxHeartRateBpm,
    avgCadenceSpm: 168,
    syncedAt: new Date(),
  };
}

/**
 * Recovery, sleep and body metrics that respond to training rather than
 * being independent noise — a hard week suppresses HRV and recovery.
 */
function generateDailyPhysiology(
  options: MockHistoryOptions,
  sessions: readonly MockSession[],
): { recoveries: NormalizedRecovery[]; sleep: NormalizedSleep[]; body: NormalizedBodyMeasurement[] } {
  const rng = makeRng(hashString(`${options.athleteId}:physiology`));
  const recoveries: NormalizedRecovery[] = [];
  const sleep: NormalizedSleep[] = [];
  const body: NormalizedBodyMeasurement[] = [];

  const loadByDate = new Map<string, number>();
  for (const session of sessions) {
    const key = session.start.toISOString().slice(0, 10);
    const intensity = session.type === 'intervals' || session.type === 'threshold' ? 1.5 : 1;
    loadByDate.set(key, (loadByDate.get(key) ?? 0) + (session.durationSeconds / 60) * intensity);
  }

  const totalDays = options.weeks * 7;
  const end = new Date(options.endDate);
  end.setUTCHours(0, 0, 0, 0);

  const hrvBaseline = 62;
  const rhrBaseline = 48;

  for (let i = 0; i < totalDays; i++) {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - (totalDays - 1 - i));
    const key = date.toISOString().slice(0, 10);

    // Yesterday's work drives today's recovery.
    const previous = new Date(date);
    previous.setUTCDate(previous.getUTCDate() - 1);
    const yesterdayLoad = loadByDate.get(previous.toISOString().slice(0, 10)) ?? 0;
    const loadPenalty = Math.min(28, yesterdayLoad * 0.28);

    const sleepHours = 6.4 + rng() * 1.8 - (yesterdayLoad > 60 ? 0.3 : 0);
    const sleepSeconds = Math.round(sleepHours * 3600);
    const sleepStart = new Date(date);
    sleepStart.setUTCDate(sleepStart.getUTCDate() - 1);
    sleepStart.setUTCHours(15, 30, 0, 0); // ~22:30 local in UTC+7

    sleep.push({
      externalId: `mock-sleep-${key}`,
      localDate: key,
      start: sleepStart,
      end: new Date(sleepStart.getTime() + sleepSeconds * 1000),
      totalSleepSeconds: sleepSeconds,
      timeInBedSeconds: Math.round(sleepSeconds * 1.08),
      lightSleepSeconds: Math.round(sleepSeconds * 0.52),
      deepSleepSeconds: Math.round(sleepSeconds * 0.22),
      remSleepSeconds: Math.round(sleepSeconds * 0.26),
      awakeSeconds: Math.round(sleepSeconds * 0.08),
      performancePercent: Math.round(Math.min(100, (sleepHours / 8) * 100)),
      consistencyPercent: 68 + Math.round(rng() * 20),
      efficiencyPercent: 88 + Math.round(rng() * 8),
      respiratoryRate: 14 + rng() * 2,
      disturbanceCount: Math.round(rng() * 3),
      isNap: false,
      raw: { mock: true },
    });

    const sleepBonus = (sleepHours - 7) * 6;
    const recoveryScore = Math.max(
      12,
      Math.min(99, 70 + sleepBonus - loadPenalty + (rng() * 12 - 6)),
    );

    recoveries.push({
      externalId: `mock-recovery-${key}`,
      localDate: key,
      recoveryScore: Math.round(recoveryScore),
      // HRV tracks recovery; RHR moves inversely.
      hrvRmssdMs: hrvBaseline * (0.82 + (recoveryScore / 100) * 0.32) + (rng() * 4 - 2),
      restingHeartRateBpm: rhrBaseline + (70 - recoveryScore) * 0.07 + (rng() * 2 - 1),
      spo2Percent: 96 + rng() * 2,
      skinTempCelsius: 33.2 + rng() * 0.8,
      calibrating: false,
      raw: { mock: true },
    });

    // Weekly weigh-in, drifting slightly downward.
    if (i % 7 === 0) {
      const weight = 65.4 - (i / totalDays) * 0.8 + (rng() * 0.5 - 0.25);
      body.push({
        metric: 'weight_kg',
        originalValue: weight,
        normalizedValue: weight,
        measuredAt: date,
      });
    }
  }

  body.push({ metric: 'height_m', originalValue: 1.71, normalizedValue: 1.71, measuredAt: end });
  body.push({ metric: 'max_hr', originalValue: 194, normalizedValue: 194, measuredAt: end });

  return { recoveries, sleep, body };
}

const MOCK_CAPABILITIES: ProviderCapabilities = {
  serverPull: true,
  webhooks: false,
  workouts: true,
  recovery: true,
  sleep: true,
  bodyMeasurements: true,
  routes: false,
};

/**
 * A provider that fabricates a plausible history for one real provider's
 * identity, so the rest of the system cannot tell it is in mock mode.
 */
export class MockProvider implements FitnessDataProvider {
  readonly capabilities = MOCK_CAPABILITIES;

  constructor(
    readonly id: 'strava' | 'whoop' | 'healthkit',
    readonly displayName: string,
    readonly scopes: readonly string[],
    readonly dataDescription: readonly string[],
    private readonly weeks = 12,
  ) {}

  isConfigured(): boolean {
    return true;
  }

  buildAuthorizationUrl(args: { state: string }): string {
    // Points at our own callback so the OAuth round-trip completes locally.
    return `/api/connections/${this.id}/callback?code=mock-code&state=${encodeURIComponent(args.state)}`;
  }

  async exchangeCode(): Promise<OAuthTokens> {
    return {
      accessToken: `mock-access-${this.id}`,
      refreshToken: `mock-refresh-${this.id}`,
      expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
      scopes: [...this.scopes],
      externalUserId: `mock-user-${this.id}`,
    };
  }

  async refreshTokens(): Promise<OAuthTokens> {
    return this.exchangeCode();
  }

  async revoke(): Promise<void> {
    return;
  }

  async sync(args: {
    tokens: OAuthTokens;
    window: SyncWindow;
    athleteId: string;
    timezone: string;
  }): Promise<ProviderSyncPayload> {
    const payload = emptyPayload();
    const options: MockHistoryOptions = {
      athleteId: args.athleteId,
      weeks: this.weeks,
      endDate: new Date(),
      timezone: args.timezone,
    };

    const sessions = generateSessions(options);

    // Only report sessions inside the requested window, so incremental sync
    // behaves like the real thing.
    const inWindow = sessions.filter(
      (s) => !args.window.since || s.start.getTime() >= args.window.since.getTime(),
    );

    if (this.id === 'strava') {
      payload.workouts = inWindow.map((s) => toStravaWorkout(s, args.athleteId, args.timezone));
    } else if (this.id === 'whoop') {
      payload.workouts = inWindow.map((s) => toWhoopWorkout(s, args.athleteId, args.timezone));
      const physiology = generateDailyPhysiology(options, sessions);
      payload.recoveries = physiology.recoveries;
      payload.sleep = physiology.sleep;
      payload.bodyMeasurements = physiology.body;
    } else {
      payload.workouts = inWindow.map((s) => toHealthKitWorkout(s, args.athleteId, args.timezone));
      const physiology = generateDailyPhysiology(options, sessions);
      payload.bodyMeasurements = physiology.body.filter((b) => b.metric === 'weight_kg');
    }

    payload.nextCursor = { syncedThrough: new Date().toISOString() };
    return payload;
  }
}
