/**
 * Test fixtures: realistic, deterministic athlete data.
 *
 * Deliberately modelled on a real training pattern rather than round numbers,
 * so the engines are exercised against data with the messiness they will
 * actually see (GPS distance disagreeing between providers, clipped
 * auto-detected activities, missing heart rate on some sessions).
 */

import type {
  CanonicalWorkout,
  ProviderWorkout,
  WorkoutSample,
  WorkoutType,
} from '../domain/workout.js';
import type { AthleteProfile } from '../domain/athlete.js';

export const TEST_TZ = 'Asia/Jakarta';

export function makeAthlete(overrides: Partial<AthleteProfile> = {}): AthleteProfile {
  return {
    id: 'athlete-1',
    userId: 'user-1',
    displayName: 'Test Athlete',
    dateOfBirth: '2002-03-14',
    sex: 'male',
    background: {
      experience: 'recreational',
      typicalWeeklyDistanceMeters: 30_000,
      typicalSessionsPerWeek: 4,
      longestRecentRunMeters: 14_000,
      selfReportedEasyPaceSecondsPerKm: 390,
      yearsRunning: 3,
    },
    availability: {
      runDays: [1, 2, 4, 6, 0],
      longRunDay: 0,
      restDays: [3, 5],
      strengthDays: [2],
      crossTrainingDays: [],
      maxSessionsPerWeek: 5,
      typicalWeekdayMinutes: 60,
      typicalLongRunMinutes: 110,
      preferredTimeOfDay: 'early_morning',
    },
    constraints: {
      activePain: false,
      hasTreadmillAccess: true,
      hasTrackAccess: false,
      hasGymAccess: true,
      surfacePreference: 'road',
      unavailableDates: [],
    },
    preferences: {
      units: 'metric',
      primaryZoneMethodology: 'hr_reserve',
      timezone: TEST_TZ,
      notifications: {
        dailyWorkout: true,
        morningCheckIn: true,
        weeklyReview: true,
        planAdjustments: true,
        syncFailures: true,
      },
    },
    markers: {
      thresholdHeartRateBpm: 172,
      thresholdPaceSecondsPerKm: 300,
    },
    raceResults: [
      {
        id: 'race-1',
        distanceMeters: 5000,
        durationSeconds: 1540, // 25:40
        date: '2026-06-20',
        source: 'self_reported',
        name: 'Parkrun',
      },
    ],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

/** Build a provider workout with sensible defaults. */
export function makeProviderWorkout(
  overrides: Partial<ProviderWorkout> & Pick<ProviderWorkout, 'provider' | 'externalId'>,
): ProviderWorkout {
  const start = overrides.startTime ?? new Date('2026-08-11T02:00:00Z');
  const durationSeconds = overrides.durationSeconds ?? 2702;
  return {
    athleteId: 'athlete-1',
    type: 'easy',
    sport: 'run',
    startTime: start,
    endTime: overrides.endTime ?? new Date(start.getTime() + durationSeconds * 1000),
    timezone: TEST_TZ,
    durationSeconds,
    distanceMeters: 7120,
    avgHeartRateBpm: 148,
    syncedAt: new Date('2026-08-11T05:00:00Z'),
    ...overrides,
  };
}

export function makeCanonicalWorkout(
  overrides: Partial<CanonicalWorkout> = {},
): CanonicalWorkout {
  const start = overrides.startTime ?? new Date('2026-08-11T02:00:00Z');
  const durationSeconds = overrides.durationSeconds ?? 2700;
  const distanceMeters = overrides.distanceMeters ?? 7000;
  return {
    id: 'w-1',
    athleteId: 'athlete-1',
    sourceRecords: [{ provider: 'strava', externalId: 's-1', contributedFields: ['distanceMeters'] }],
    type: 'easy',
    sport: 'run',
    startTime: start,
    endTime: new Date(start.getTime() + durationSeconds * 1000),
    timezone: TEST_TZ,
    durationSeconds,
    movingTimeSeconds: durationSeconds,
    distanceMeters,
    avgHeartRateBpm: 148,
    maxHeartRateBpm: 165,
    avgPaceSecondsPerKm: (durationSeconds / distanceMeters) * 1000,
    sourceConfidence: 0.8,
    createdAt: new Date('2026-08-11T05:00:00Z'),
    updatedAt: new Date('2026-08-11T05:00:00Z'),
    ...overrides,
  };
}

/**
 * Generate a steady-run sample stream with controllable cardiac drift.
 *
 * @param driftPercent how much the speed-per-beat ratio degrades over the run.
 */
export function makeSteadySamples(options: {
  durationSeconds: number;
  intervalSeconds?: number;
  speedMps: number;
  startHeartRate: number;
  driftPercent: number;
  /** Relative pace jitter, to simulate a non-perfectly-steady run. */
  jitter?: number;
}): WorkoutSample[] {
  const interval = options.intervalSeconds ?? 10;
  const count = Math.floor(options.durationSeconds / interval);
  const samples: WorkoutSample[] = [];

  for (let i = 0; i < count; i++) {
    const progress = count <= 1 ? 0 : i / (count - 1);
    // Deterministic pseudo-jitter so tests stay reproducible.
    const jitter = options.jitter ? Math.sin(i * 1.7) * options.jitter : 0;
    const speed = options.speedMps * (1 + jitter);
    // Raising HR while holding speed produces positive drift.
    const hr = options.startHeartRate * (1 + (options.driftPercent / 100) * progress);
    samples.push({
      offsetSeconds: i * interval,
      speedMps: speed,
      heartRateBpm: hr,
      distanceMeters: options.speedMps * i * interval,
    });
  }
  return samples;
}

/** A run of N weeks of daily loads following a build/deload pattern. */
export function makeDailyLoads(
  startDate: string,
  weeks: number,
  weeklyPattern: readonly number[],
): { date: string; load: number }[] {
  const out: { date: string; load: number }[] = [];
  const parse = (s: string): Date => new Date(`${s}T12:00:00Z`);
  const cursor = parse(startDate);

  for (let week = 0; week < weeks; week++) {
    for (let day = 0; day < 7; day++) {
      out.push({
        date: cursor.toISOString().slice(0, 10),
        load: weeklyPattern[day] ?? 0,
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  return out;
}

export const WORKOUT_TYPES_FOR_TEST: WorkoutType[] = [
  'easy',
  'long',
  'intervals',
  'threshold',
  'recovery',
];
