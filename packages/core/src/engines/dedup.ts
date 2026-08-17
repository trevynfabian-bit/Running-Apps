/**
 * Cross-provider workout deduplication and merge.
 *
 * The same run can arrive three times: once from the watch via Strava, once
 * from WHOOP's auto-detected activity, once from Apple Health. Counting it
 * three times would inflate volume and training load and corrupt every
 * downstream metric, so matching is the single most safety-critical piece of
 * the ingest path.
 *
 * Approach
 * --------
 * Pairwise similarity scoring over several independent signals, rather than a
 * single hard rule. No individual signal is trusted alone: clocks drift
 * between devices, GPS distance disagrees by a few percent between platforms,
 * and WHOOP's auto-detection clips the start of a run. A weighted score with
 * a hard time-proximity gate handles all of that while still refusing to merge
 * genuinely distinct sessions (e.g. a double day).
 *
 * Merge policy
 * ------------
 * Fields are taken from the provider best positioned to know them, not from
 * whichever synced last. GPS distance from Strava beats WHOOP's estimate;
 * heart rate from WHOOP's chest-adjacent sensor beats a phone estimate.
 */

import type {
  CanonicalWorkout,
  ProviderWorkout,
  WorkoutSourceRef,
  GeoPoint,
} from '../domain/workout.js';
import { effectivePaceSecondsPerKm } from '../domain/workout.js';
import type { ProviderId } from '../domain/provenance.js';
import { absSecondsBetween, overlapSeconds } from '../util/time.js';
import { clamp, compact } from '../util/stats.js';

export interface DedupConfig {
  /**
   * Hard gate: candidates whose start times differ by more than this are never
   * merged, whatever the other signals say. Auto-detected activities routinely
   * start a minute or two late, but not ten.
   */
  maxStartTimeDeltaSeconds: number;
  /** Relative duration difference tolerated, e.g. 0.15 = 15%. */
  maxDurationRelativeDelta: number;
  /** Relative distance difference tolerated. */
  maxDistanceRelativeDelta: number;
  /** Minimum weighted score (0..1) required to merge. */
  matchThreshold: number;
}

export const DEFAULT_DEDUP_CONFIG: DedupConfig = {
  maxStartTimeDeltaSeconds: 15 * 60,
  maxDurationRelativeDelta: 0.2,
  maxDistanceRelativeDelta: 0.15,
  matchThreshold: 0.62,
};

/**
 * Per-field provider trust for the merge step.
 * Lower index = more trusted for that field.
 */
const FIELD_PRIORITY: Record<string, readonly ProviderId[]> = {
  // GPS-derived: Strava's processing is the most mature, HealthKit next.
  distanceMeters: ['strava', 'healthkit', 'whoop', 'manual'],
  elevationGainMeters: ['strava', 'healthkit', 'whoop', 'manual'],
  route: ['strava', 'healthkit', 'whoop', 'manual'],
  // Heart rate: WHOOP samples continuously from a dedicated sensor.
  avgHeartRateBpm: ['whoop', 'healthkit', 'strava', 'manual'],
  maxHeartRateBpm: ['whoop', 'healthkit', 'strava', 'manual'],
  // Duration: the device that recorded the workout knows best; Strava's
  // moving-time processing is the most consistent.
  durationSeconds: ['strava', 'healthkit', 'whoop', 'manual'],
  movingTimeSeconds: ['strava', 'healthkit', 'whoop', 'manual'],
  calories: ['whoop', 'healthkit', 'strava', 'manual'],
  avgCadenceSpm: ['healthkit', 'strava', 'whoop', 'manual'],
  avgPowerWatts: ['healthkit', 'strava', 'whoop', 'manual'],
};

const DEFAULT_FIELD_PRIORITY: readonly ProviderId[] = ['strava', 'healthkit', 'whoop', 'manual'];

export interface SimilarityBreakdown {
  /** 0..1 overall. */
  score: number;
  /** Per-signal scores, for debugging why a merge did or didn't happen. */
  signals: Record<string, number | undefined>;
  /** True when a hard gate rejected the pair outright. */
  rejected: boolean;
  rejectionReason?: string;
}

/**
 * Score how likely it is that two provider records describe the same session.
 */
export function similarity(
  a: ProviderWorkout,
  b: ProviderWorkout,
  config: DedupConfig = DEFAULT_DEDUP_CONFIG,
): SimilarityBreakdown {
  const signals: Record<string, number | undefined> = {};

  // The same provider never deduplicates against itself: two Strava activities
  // are two activities, even if they look alike.
  if (a.provider === b.provider) {
    return { score: 0, signals, rejected: true, rejectionReason: 'same_provider' };
  }

  if (a.sport !== b.sport) {
    return { score: 0, signals, rejected: true, rejectionReason: 'sport_mismatch' };
  }

  // --- Hard gate: start time proximity -------------------------------------
  const startDelta = absSecondsBetween(a.startTime, b.startTime);
  if (startDelta > config.maxStartTimeDeltaSeconds) {
    return {
      score: 0,
      signals: { startTime: 0 },
      rejected: true,
      rejectionReason: 'start_time_too_far',
    };
  }
  // Decays from 1 at a perfect match to 0 at the gate.
  signals.startTime = clamp(1 - startDelta / config.maxStartTimeDeltaSeconds, 0, 1);

  // --- Temporal overlap ----------------------------------------------------
  const aDuration = (a.endTime.getTime() - a.startTime.getTime()) / 1000;
  const bDuration = (b.endTime.getTime() - b.startTime.getTime()) / 1000;
  const shorter = Math.min(aDuration, bDuration);
  if (shorter > 0) {
    const overlap = overlapSeconds(a.startTime, a.endTime, b.startTime, b.endTime);
    signals.overlap = clamp(overlap / shorter, 0, 1);
  }

  // --- Duration similarity -------------------------------------------------
  const aDur = a.durationSeconds ?? aDuration;
  const bDur = b.durationSeconds ?? bDuration;
  if (aDur > 0 && bDur > 0) {
    const rel = Math.abs(aDur - bDur) / Math.max(aDur, bDur);
    if (rel > config.maxDurationRelativeDelta) {
      return {
        score: 0,
        signals: { ...signals, duration: 0 },
        rejected: true,
        rejectionReason: 'duration_mismatch',
      };
    }
    signals.duration = clamp(1 - rel / config.maxDurationRelativeDelta, 0, 1);
  }

  // --- Distance similarity -------------------------------------------------
  if (a.distanceMeters && b.distanceMeters && a.distanceMeters > 0 && b.distanceMeters > 0) {
    const rel =
      Math.abs(a.distanceMeters - b.distanceMeters) /
      Math.max(a.distanceMeters, b.distanceMeters);
    if (rel > config.maxDistanceRelativeDelta) {
      return {
        score: 0,
        signals: { ...signals, distance: 0 },
        rejected: true,
        rejectionReason: 'distance_mismatch',
      };
    }
    signals.distance = clamp(1 - rel / config.maxDistanceRelativeDelta, 0, 1);
  }

  // --- Heart rate similarity ----------------------------------------------
  if (a.avgHeartRateBpm && b.avgHeartRateBpm) {
    // 10 bpm apart on the same session is already suspicious.
    const delta = Math.abs(a.avgHeartRateBpm - b.avgHeartRateBpm);
    signals.heartRate = clamp(1 - delta / 15, 0, 1);
  }

  // --- Route similarity ----------------------------------------------------
  const routeScore = routeSimilarity(a.route, b.route);
  if (routeScore !== undefined) signals.route = routeScore;

  // --- Weighted combination ------------------------------------------------
  // Weights reflect how discriminating each signal is. Start time and overlap
  // carry most of the load; heart rate and route confirm.
  const weights: Record<string, number> = {
    startTime: 0.3,
    overlap: 0.25,
    duration: 0.2,
    distance: 0.15,
    heartRate: 0.05,
    route: 0.05,
  };

  let weightedSum = 0;
  let totalWeight = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const value = signals[key];
    if (value === undefined) continue;
    weightedSum += value * weight;
    totalWeight += weight;
  }

  const score = totalWeight === 0 ? 0 : weightedSum / totalWeight;
  return { score, signals, rejected: false };
}

/**
 * Compare two GPS traces by sampling start/middle/end positions.
 * A full trajectory comparison isn't worth the cost at ingest time; three
 * anchor points already separate "same route" from "different route" well.
 */
function routeSimilarity(a?: GeoPoint[], b?: GeoPoint[]): number | undefined {
  if (!a?.length || !b?.length) return undefined;

  const anchors = (points: GeoPoint[]): GeoPoint[] =>
    compact([points[0], points[Math.floor(points.length / 2)], points[points.length - 1]]);

  const aAnchors = anchors(a);
  const bAnchors = anchors(b);
  if (aAnchors.length !== bAnchors.length) return undefined;

  let totalScore = 0;
  for (let i = 0; i < aAnchors.length; i++) {
    const meters = haversineMeters(aAnchors[i]!, bAnchors[i]!);
    // Within 50 m is effectively identical; beyond 500 m is a different place.
    totalScore += clamp(1 - (meters - 50) / 450, 0, 1);
  }
  return totalScore / aAnchors.length;
}

/** Great-circle distance between two coordinates, in metres. */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Group provider records into clusters that each represent one real session.
 *
 * Single-link clustering: a record joins a cluster if it matches ANY member.
 * That is the right choice here because a WHOOP record may match a Strava
 * record strongly while matching the HealthKit record only weakly (different
 * clipping), yet all three are the same run.
 */
export function clusterWorkouts(
  workouts: readonly ProviderWorkout[],
  config: DedupConfig = DEFAULT_DEDUP_CONFIG,
): ProviderWorkout[][] {
  // Chronological order keeps clusters contiguous and makes the result stable.
  const sorted = [...workouts].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  const clusters: ProviderWorkout[][] = [];

  for (const workout of sorted) {
    let target: ProviderWorkout[] | undefined;

    for (const cluster of clusters) {
      const matches = cluster.some((member) => {
        const result = similarity(member, workout, config);
        return !result.rejected && result.score >= config.matchThreshold;
      });
      if (matches) {
        target = cluster;
        break;
      }
    }

    if (target) target.push(workout);
    else clusters.push([workout]);
  }

  return clusters;
}

/** Pick the value for `field` from the highest-priority provider that has it. */
function selectField<K extends keyof ProviderWorkout>(
  cluster: readonly ProviderWorkout[],
  field: K,
): { value: NonNullable<ProviderWorkout[K]>; provider: ProviderId } | undefined {
  const priority = FIELD_PRIORITY[field as string] ?? DEFAULT_FIELD_PRIORITY;

  const candidates = cluster
    .filter((w) => w[field] !== undefined && w[field] !== null)
    .sort((a, b) => {
      const rankA = priority.indexOf(a.provider);
      const rankB = priority.indexOf(b.provider);
      return (rankA === -1 ? 99 : rankA) - (rankB === -1 ? 99 : rankB);
    });

  const winner = candidates[0];
  if (!winner) return undefined;
  return { value: winner[field] as NonNullable<ProviderWorkout[K]>, provider: winner.provider };
}

/**
 * Merge a cluster of provider records into one canonical workout.
 *
 * `id` is supplied by the caller (the persistence layer owns identity) so this
 * function stays pure and deterministic.
 */
export function mergeCluster(
  cluster: readonly ProviderWorkout[],
  options: { id: string; defaultTimezone: string; now?: Date },
): CanonicalWorkout {
  if (cluster.length === 0) {
    throw new Error('mergeCluster: cluster must not be empty');
  }

  const now = options.now ?? new Date();
  const first = cluster[0]!;

  // Track which provider supplied which field so provenance survives the merge.
  const contributions = new Map<ProviderId, Set<string>>();
  const note = (provider: ProviderId, field: string): void => {
    const existing = contributions.get(provider) ?? new Set<string>();
    existing.add(field);
    contributions.set(provider, existing);
  };

  const pick = <K extends keyof ProviderWorkout>(field: K): ProviderWorkout[K] | undefined => {
    const selected = selectField(cluster, field);
    if (!selected) return undefined;
    note(selected.provider, field as string);
    return selected.value;
  };

  // Earliest start / latest end: providers clip differently and the union is
  // the most faithful representation of when the athlete was actually working.
  const startTime = new Date(Math.min(...cluster.map((w) => w.startTime.getTime())));
  const endTime = new Date(Math.max(...cluster.map((w) => w.endTime.getTime())));

  const distanceMeters = pick('distanceMeters');
  const durationSeconds = pick('durationSeconds') ?? (endTime.getTime() - startTime.getTime()) / 1000;
  const movingTimeSeconds = pick('movingTimeSeconds');

  // Prefer the most specific declared type. Providers that only know "run"
  // shouldn't override Strava's "workout"/interval classification.
  const typeCandidate = cluster.find((w) => w.type !== 'easy') ?? first;
  note(typeCandidate.provider, 'type');

  const avgPace = effectivePaceSecondsPerKm({
    distanceMeters,
    movingTimeSeconds,
    durationSeconds,
    avgPaceSecondsPerKm: undefined,
  });

  // Every `pick` must run BEFORE `sourceRecords` is materialised, otherwise the
  // provenance map is read before the later picks have registered themselves.
  const name = pick('name');
  const avgHeartRateBpm = pick('avgHeartRateBpm');
  const maxHeartRateBpm = pick('maxHeartRateBpm');
  const elevationGainMeters = pick('elevationGainMeters');
  const avgCadenceSpm = pick('avgCadenceSpm');
  const avgPowerWatts = pick('avgPowerWatts');
  const calories = pick('calories');
  const perceivedExertion = pick('perceivedExertion');
  const splits = pick('splits');
  const samples = pick('samples');
  const route = pick('route');
  const indoor = pick('indoor');
  const temperatureCelsius = pick('temperatureCelsius');

  const sourceRecords: WorkoutSourceRef[] = cluster.map((w) => ({
    provider: w.provider,
    externalId: w.externalId,
    contributedFields: [...(contributions.get(w.provider) ?? [])].sort(),
  }));

  return {
    id: options.id,
    athleteId: first.athleteId,
    sourceRecords,
    type: typeCandidate.type,
    sport: first.sport,
    name,
    startTime,
    endTime,
    timezone: cluster.find((w) => w.timezone)?.timezone ?? options.defaultTimezone,
    durationSeconds,
    movingTimeSeconds,
    distanceMeters,
    avgHeartRateBpm,
    maxHeartRateBpm,
    avgPaceSecondsPerKm: avgPace,
    elevationGainMeters,
    avgCadenceSpm,
    avgPowerWatts,
    calories,
    perceivedExertion,
    splits,
    samples,
    route,
    indoor,
    temperatureCelsius,
    sourceConfidence: computeSourceConfidence(cluster),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 0..1 trust score for a merged record.
 *
 * Two things raise it: independent corroboration (more providers saw it) and
 * completeness (the fields the analytics layer needs are actually present).
 */
export function computeSourceConfidence(cluster: readonly ProviderWorkout[]): number {
  // One provider is the common case and shouldn't be penalised harshly;
  // corroboration is a bonus, not a requirement.
  const corroboration = clamp(0.6 + 0.2 * (cluster.length - 1), 0, 1);

  const merged = {
    distance: cluster.some((w) => w.distanceMeters !== undefined),
    duration: cluster.some((w) => w.durationSeconds !== undefined),
    heartRate: cluster.some((w) => w.avgHeartRateBpm !== undefined),
    samples: cluster.some((w) => (w.samples?.length ?? 0) > 0),
  };
  const completeness =
    (Number(merged.distance) + Number(merged.duration) + Number(merged.heartRate) +
      Number(merged.samples)) / 4;

  // Corroboration matters more than completeness for trusting the record exists.
  return clamp(0.7 * corroboration + 0.3 * completeness, 0, 1);
}

/**
 * Full pipeline: raw provider records in, canonical workouts out.
 * `idFor` lets the caller supply stable IDs (e.g. reuse an existing row's id
 * when re-merging after a late-arriving provider record).
 */
export function deduplicateWorkouts(
  workouts: readonly ProviderWorkout[],
  options: {
    idFor: (cluster: readonly ProviderWorkout[], index: number) => string;
    defaultTimezone: string;
    config?: DedupConfig;
    now?: Date;
  },
): CanonicalWorkout[] {
  const clusters = clusterWorkouts(workouts, options.config ?? DEFAULT_DEDUP_CONFIG);
  return clusters.map((cluster, index) =>
    mergeCluster(cluster, {
      id: options.idFor(cluster, index),
      defaultTimezone: options.defaultTimezone,
      now: options.now,
    }),
  );
}
