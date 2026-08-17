/**
 * Workout model: what the athlete is asked to do, and what they actually did.
 */

import type { ProviderId } from './provenance.js';

// ---------------------------------------------------------------------------
// Workout taxonomy
// ---------------------------------------------------------------------------

export const RUN_WORKOUT_TYPES = [
  'easy',
  'recovery',
  'long',
  'progression',
  'tempo',
  'threshold',
  'intervals',
  'hills',
  'strides',
  'fartlek',
  'race_simulation',
  'time_trial',
  'race',
  'treadmill',
] as const;

export const NON_RUN_WORKOUT_TYPES = ['rest', 'cross_training', 'strength'] as const;

export type RunWorkoutType = (typeof RUN_WORKOUT_TYPES)[number];
export type WorkoutType = RunWorkoutType | (typeof NON_RUN_WORKOUT_TYPES)[number];

export function isRunType(type: WorkoutType): type is RunWorkoutType {
  return (RUN_WORKOUT_TYPES as readonly string[]).includes(type);
}

/**
 * Workout types that impose meaningful neuromuscular / metabolic cost at high
 * intensity. Used by the decision engine to judge hard-day spacing.
 */
export const HARD_WORKOUT_TYPES: readonly WorkoutType[] = [
  'tempo',
  'threshold',
  'intervals',
  'hills',
  'race_simulation',
  'time_trial',
  'race',
];

export function isHardType(type: WorkoutType): boolean {
  return HARD_WORKOUT_TYPES.includes(type);
}

/** Broad sport bucket, so non-running activity still contributes to load. */
export type SportType = 'run' | 'walk' | 'ride' | 'swim' | 'strength' | 'other';

// ---------------------------------------------------------------------------
// Structured workout definition
// ---------------------------------------------------------------------------

export type IntensityTarget =
  | { kind: 'zone'; zone: number }
  | { kind: 'pace'; fastSecondsPerKm: number; slowSecondsPerKm: number }
  | { kind: 'heart_rate'; minBpm: number; maxBpm: number }
  | { kind: 'rpe'; min: number; max: number }
  | { kind: 'effort'; description: string };

export interface WorkoutStep {
  id: string;
  label: string;
  /** Exactly one of duration/distance drives the step; duration wins if both. */
  durationSeconds?: number;
  distanceMeters?: number;
  target: IntensityTarget;
  /** Present on repeat children to describe the jog/standing recovery. */
  isRecovery?: boolean;
  notes?: string;
}

/** A repeated block, e.g. `4 × 6 min @ threshold w/ 2 min jog`. */
export interface WorkoutRepeat {
  id: string;
  repetitions: number;
  steps: WorkoutStep[];
}

export type WorkoutSegment =
  | { kind: 'step'; step: WorkoutStep }
  | { kind: 'repeat'; repeat: WorkoutRepeat };

export interface WorkoutStructure {
  warmup?: WorkoutStep;
  main: WorkoutSegment[];
  cooldown?: WorkoutStep;
}

// ---------------------------------------------------------------------------
// Planned workout
// ---------------------------------------------------------------------------

export type PlannedWorkoutStatus =
  | 'planned'
  | 'completed'
  | 'partially_completed'
  | 'modified'
  | 'skipped';

export interface PlannedWorkout {
  id: string;
  planId: string;
  blockId: string;
  /** Local calendar date (athlete timezone), `YYYY-MM-DD`. */
  date: string;
  type: WorkoutType;
  title: string;
  /** One line on *why* this session exists, shown in the UI. */
  purpose: string;
  targetDistanceMeters?: number;
  targetDurationSeconds?: number;
  structure?: WorkoutStructure;
  targetRpe?: number;
  status: PlannedWorkoutStatus;
  /** Set when the coach engine altered this session from its original form. */
  modifiedFrom?: {
    type: WorkoutType;
    targetDistanceMeters?: number;
    targetDurationSeconds?: number;
    reason: string;
  };
  completedWorkoutId?: string;
}

// ---------------------------------------------------------------------------
// Canonical (actually-performed) workout
// ---------------------------------------------------------------------------

export interface GeoPoint {
  lat: number;
  lon: number;
  elevationMeters?: number;
  /** Seconds elapsed from workout start. */
  offsetSeconds?: number;
}

/** A time-ordered sample stream, used for drift and interval analysis. */
export interface WorkoutSample {
  offsetSeconds: number;
  heartRateBpm?: number;
  /** Instantaneous speed in m/s. */
  speedMps?: number;
  distanceMeters?: number;
  cadenceSpm?: number;
  powerWatts?: number;
  elevationMeters?: number;
}

export interface WorkoutSplit {
  index: number;
  distanceMeters: number;
  durationSeconds: number;
  avgHeartRateBpm?: number;
  elevationGainMeters?: number;
}

/** Pointer back to the provider record(s) a canonical workout was built from. */
export interface WorkoutSourceRef {
  provider: ProviderId;
  externalId: string;
  /** Fields this provider contributed to the merged record. */
  contributedFields: string[];
}

/**
 * The single, deduplicated record of one training session, merged from every
 * provider that saw it. This is what the whole analytics layer reads.
 */
export interface CanonicalWorkout {
  id: string;
  athleteId: string;

  sourceRecords: WorkoutSourceRef[];

  type: WorkoutType;
  sport: SportType;
  name?: string;

  startTime: Date;
  endTime: Date;
  /** Athlete's IANA timezone at the time of the workout. */
  timezone: string;

  durationSeconds?: number;
  /** Moving time excludes pauses; preferred for pace when available. */
  movingTimeSeconds?: number;
  distanceMeters?: number;

  avgHeartRateBpm?: number;
  maxHeartRateBpm?: number;

  avgPaceSecondsPerKm?: number;
  elevationGainMeters?: number;

  avgCadenceSpm?: number;
  avgPowerWatts?: number;
  calories?: number;

  /** Athlete-reported exertion, 1-10. Drives session load when HR is absent. */
  perceivedExertion?: number;

  /** Internal training load, computed by the load engine. */
  trainingLoad?: number;

  splits?: WorkoutSplit[];
  samples?: WorkoutSample[];
  route?: GeoPoint[];

  indoor?: boolean;
  /** Ambient temperature in °C, when a provider supplies it. */
  temperatureCelsius?: number;

  /**
   * 0..1 measure of how much we trust this record, driven by how many
   * independent providers agreed and how complete the data is.
   */
  sourceConfidence: number;

  /** Link back to the plan, once matched. */
  plannedWorkoutId?: string;

  createdAt: Date;
  updatedAt: Date;
}

/**
 * A provider's raw view of a workout, before dedup/merge.
 * The dedup engine consumes these and emits `CanonicalWorkout`s.
 */
export interface ProviderWorkout {
  provider: ProviderId;
  externalId: string;
  athleteId: string;

  type: WorkoutType;
  sport: SportType;
  name?: string;

  startTime: Date;
  endTime: Date;
  timezone?: string;

  durationSeconds?: number;
  movingTimeSeconds?: number;
  distanceMeters?: number;

  avgHeartRateBpm?: number;
  maxHeartRateBpm?: number;
  elevationGainMeters?: number;
  avgCadenceSpm?: number;
  avgPowerWatts?: number;
  calories?: number;
  perceivedExertion?: number;

  splits?: WorkoutSplit[];
  samples?: WorkoutSample[];
  route?: GeoPoint[];

  indoor?: boolean;
  temperatureCelsius?: number;

  syncedAt: Date;
}

/** Effective pace, preferring moving time when the provider reports it. */
export function effectivePaceSecondsPerKm(
  workout: Pick<
    CanonicalWorkout,
    'distanceMeters' | 'movingTimeSeconds' | 'durationSeconds' | 'avgPaceSecondsPerKm'
  >,
): number | undefined {
  if (workout.avgPaceSecondsPerKm !== undefined) return workout.avgPaceSecondsPerKm;
  const seconds = workout.movingTimeSeconds ?? workout.durationSeconds;
  if (!workout.distanceMeters || !seconds || workout.distanceMeters <= 0 || seconds <= 0) {
    return undefined;
  }
  return (seconds / workout.distanceMeters) * 1000;
}
