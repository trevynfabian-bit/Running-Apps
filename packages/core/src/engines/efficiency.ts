/**
 * Aerobic efficiency and heart-rate drift.
 *
 * These are the two metrics that most directly answer "am I actually getting
 * fitter?" — more so than volume, which only measures what you did.
 *
 * Efficiency Factor (EF)
 * ----------------------
 * Speed divided by heart rate: metres per minute per beat. Rising EF at a
 * constant heart rate means the athlete is producing more speed for the same
 * cardiovascular cost, which is the definition of improving aerobic fitness.
 *
 * The comparison is only valid between *comparable* sessions. Heat, hills,
 * treadmill vs road, fatigue and workout type all move EF independently of
 * fitness, so `comparableEfficiencyPoints` filters aggressively before any
 * trend is computed. It is better to say "not enough comparable runs yet"
 * than to report a trend that is really a weather report.
 *
 * Aerobic decoupling (Pw:HR / Pa:HR)
 * ----------------------------------
 * Split a steady run in half and compare the pace:HR ratio of each half.
 * If the second half needs a higher heart rate for the same pace, the athlete
 * "decoupled" — cardiac drift exceeded what the effort should require.
 *
 * Interpretation is genuinely ambiguous: drift is caused by dehydration, heat,
 * glycogen depletion, insufficient aerobic base, or simply starting too fast.
 * A single session therefore never supports a causal claim, and this module
 * returns the number plus an explicitly hedged interpretation.
 */

import type { CanonicalWorkout, WorkoutSample } from '../domain/workout.js';
import { effectivePaceSecondsPerKm } from '../domain/workout.js';
import { linearRegression, mean, round } from '../util/stats.js';
import { toLocalDate } from '../util/time.js';

// ---------------------------------------------------------------------------
// Efficiency factor
// ---------------------------------------------------------------------------

export interface EfficiencyPoint {
  workoutId: string;
  date: string;
  /** Metres per minute per beat. Higher is better. */
  efficiencyFactor: number;
  paceSecondsPerKm: number;
  avgHeartRateBpm: number;
  distanceMeters: number;
  /** Conditions that could confound comparison. */
  context: {
    indoor: boolean;
    temperatureCelsius?: number;
    elevationGainPerKm?: number;
    workoutType: string;
  };
}

/**
 * Efficiency factor for a single workout: speed (m/min) ÷ average HR.
 */
export function efficiencyFactor(
  distanceMeters: number,
  durationSeconds: number,
  avgHeartRateBpm: number,
): number | undefined {
  if (distanceMeters <= 0 || durationSeconds <= 0 || avgHeartRateBpm <= 0) return undefined;
  const metersPerMinute = distanceMeters / (durationSeconds / 60);
  return metersPerMinute / avgHeartRateBpm;
}

export function toEfficiencyPoint(workout: CanonicalWorkout): EfficiencyPoint | undefined {
  const seconds = workout.movingTimeSeconds ?? workout.durationSeconds;
  if (!seconds || !workout.distanceMeters || !workout.avgHeartRateBpm) return undefined;

  const ef = efficiencyFactor(workout.distanceMeters, seconds, workout.avgHeartRateBpm);
  const pace = effectivePaceSecondsPerKm(workout);
  if (ef === undefined || pace === undefined) return undefined;

  return {
    workoutId: workout.id,
    date: toLocalDate(workout.startTime, workout.timezone),
    efficiencyFactor: ef,
    paceSecondsPerKm: pace,
    avgHeartRateBpm: workout.avgHeartRateBpm,
    distanceMeters: workout.distanceMeters,
    context: {
      indoor: workout.indoor ?? false,
      temperatureCelsius: workout.temperatureCelsius,
      elevationGainPerKm:
        workout.elevationGainMeters !== undefined && workout.distanceMeters > 0
          ? workout.elevationGainMeters / (workout.distanceMeters / 1000)
          : undefined,
      workoutType: workout.type,
    },
  };
}

export interface ComparabilityFilter {
  /** Only compare runs of this type family. */
  allowedTypes: readonly string[];
  minDistanceMeters: number;
  maxElevationGainPerKm: number;
  /** Exclude runs hotter than this; heat inflates HR independently of fitness. */
  maxTemperatureCelsius?: number;
  /** Treadmill and outdoor runs are not directly comparable. */
  indoor?: boolean;
}

export const DEFAULT_COMPARABILITY: ComparabilityFilter = {
  // Steady aerobic running only. Interval sessions have meaningless average HR.
  allowedTypes: ['easy', 'long', 'recovery', 'steady', 'treadmill'],
  minDistanceMeters: 3000,
  maxElevationGainPerKm: 20,
  maxTemperatureCelsius: 28,
};

/**
 * Keep only the points that can be fairly compared with each other.
 * Deliberately strict — a small honest sample beats a large misleading one.
 */
export function comparableEfficiencyPoints(
  points: readonly EfficiencyPoint[],
  filter: ComparabilityFilter = DEFAULT_COMPARABILITY,
): EfficiencyPoint[] {
  return points.filter((point) => {
    if (!filter.allowedTypes.includes(point.context.workoutType)) return false;
    if (point.distanceMeters < filter.minDistanceMeters) return false;
    if (
      point.context.elevationGainPerKm !== undefined &&
      point.context.elevationGainPerKm > filter.maxElevationGainPerKm
    ) {
      return false;
    }
    if (
      filter.maxTemperatureCelsius !== undefined &&
      point.context.temperatureCelsius !== undefined &&
      point.context.temperatureCelsius > filter.maxTemperatureCelsius
    ) {
      return false;
    }
    if (filter.indoor !== undefined && point.context.indoor !== filter.indoor) return false;
    return true;
  });
}

export interface EfficiencyTrend {
  /** Percent change in EF over the window. Positive = improving. */
  changePercent: number;
  /** Slope in EF units per day. */
  slopePerDay: number;
  /** Goodness of fit, 0..1. */
  r2: number;
  sampleCount: number;
  windowDays: number;
  direction: 'improving' | 'stable' | 'declining';
  confidence: 'low' | 'moderate' | 'high';
  /** Honest summary, including caveats. */
  interpretation: string;
}

/**
 * Fit a trend through comparable efficiency points.
 *
 * Requires at least 4 points; below that a "trend" is noise. Confidence is
 * driven by sample count and fit quality, not by the size of the change —
 * a big change from 4 scattered points is not strong evidence.
 */
export function efficiencyTrend(
  points: readonly EfficiencyPoint[],
  options: { minSamples?: number } = {},
): EfficiencyTrend | undefined {
  const minSamples = options.minSamples ?? 4;
  if (points.length < minSamples) return undefined;

  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;

  const toDayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
  const originDay = toDayNumber(first.date);

  const regression = linearRegression(
    sorted.map((p) => ({ x: toDayNumber(p.date) - originDay, y: p.efficiencyFactor })),
  );
  if (!regression) return undefined;

  const windowDays = toDayNumber(last.date) - originDay;
  if (windowDays <= 0) return undefined;

  const baseline = mean(sorted.slice(0, Math.max(1, Math.floor(sorted.length / 3))).map((p) => p.efficiencyFactor))!;
  const totalChange = regression.slope * windowDays;
  const changePercent = baseline === 0 ? 0 : (totalChange / baseline) * 100;

  // A 2% shift over a multi-week window is within measurement noise for EF.
  const direction: EfficiencyTrend['direction'] =
    Math.abs(changePercent) < 2 ? 'stable' : changePercent > 0 ? 'improving' : 'declining';

  const confidence: EfficiencyTrend['confidence'] =
    sorted.length >= 8 && regression.r2 > 0.4
      ? 'high'
      : sorted.length >= 6 || regression.r2 > 0.3
        ? 'moderate'
        : 'low';

  return {
    changePercent: round(changePercent, 1),
    slopePerDay: regression.slope,
    r2: round(regression.r2, 3),
    sampleCount: sorted.length,
    windowDays: Math.round(windowDays),
    direction,
    confidence,
    interpretation: interpretEfficiency(direction, changePercent, sorted.length, confidence),
  };
}

function interpretEfficiency(
  direction: EfficiencyTrend['direction'],
  changePercent: number,
  sampleCount: number,
  confidence: EfficiencyTrend['confidence'],
): string {
  const magnitude = Math.abs(changePercent).toFixed(1);
  const caveat =
    confidence === 'low'
      ? ' This is based on few comparable runs, so treat it as provisional.'
      : '';

  switch (direction) {
    case 'improving':
      return `Your pace at a given heart rate has improved about ${magnitude}% across ${sampleCount} comparable aerobic runs. That is consistent with improving aerobic fitness.${caveat}`;
    case 'declining':
      return `Your pace at a given heart rate is about ${magnitude}% slower across ${sampleCount} comparable aerobic runs. Accumulated fatigue, heat, or a break in training can all produce this.${caveat}`;
    case 'stable':
      return `Your pace-to-heart-rate relationship has been stable across ${sampleCount} comparable aerobic runs.${caveat}`;
  }
}

// ---------------------------------------------------------------------------
// Aerobic decoupling / HR drift
// ---------------------------------------------------------------------------

export interface DecouplingResult {
  /** Percent drift: positive means HR rose relative to pace. */
  driftPercent: number;
  firstHalf: { paceSecondsPerKm: number; avgHeartRateBpm: number; ratio: number };
  secondHalf: { paceSecondsPerKm: number; avgHeartRateBpm: number; ratio: number };
  /** Whether the run was steady enough for the number to mean anything. */
  isValid: boolean;
  invalidReason?: string;
  interpretation: string;
}

/**
 * Compute aerobic decoupling from a sample stream.
 *
 * Validity gates, all of which must pass:
 *  - at least 20 minutes of samples (shorter runs never show real drift)
 *  - HR present throughout
 *  - the run is steady: pace variability low enough that this isn't an
 *    interval session, where "drift" is meaningless
 */
export function computeDecoupling(
  samples: readonly WorkoutSample[],
  options: { minDurationSeconds?: number; maxPaceCoefficientOfVariation?: number } = {},
): DecouplingResult | undefined {
  const minDuration = options.minDurationSeconds ?? 20 * 60;
  const maxCv = options.maxPaceCoefficientOfVariation ?? 0.18;

  const usable = samples
    .filter((s) => s.heartRateBpm !== undefined && s.speedMps !== undefined && s.speedMps > 0)
    .sort((a, b) => a.offsetSeconds - b.offsetSeconds);

  if (usable.length < 20) return undefined;

  const totalSeconds = usable[usable.length - 1]!.offsetSeconds - usable[0]!.offsetSeconds;
  if (totalSeconds < minDuration) {
    return {
      driftPercent: 0,
      firstHalf: { paceSecondsPerKm: 0, avgHeartRateBpm: 0, ratio: 0 },
      secondHalf: { paceSecondsPerKm: 0, avgHeartRateBpm: 0, ratio: 0 },
      isValid: false,
      invalidReason: 'Run too short for a meaningful drift measurement (needs 20+ minutes).',
      interpretation: 'Not enough steady running time to assess heart-rate drift.',
    };
  }

  const midpoint = usable[0]!.offsetSeconds + totalSeconds / 2;
  const firstSamples = usable.filter((s) => s.offsetSeconds < midpoint);
  const secondSamples = usable.filter((s) => s.offsetSeconds >= midpoint);
  if (firstSamples.length < 5 || secondSamples.length < 5) return undefined;

  // Steadiness gate: high pace variability means this is an interval session.
  const speeds = usable.map((s) => s.speedMps!);
  const speedMean = mean(speeds)!;
  const speedSd = Math.sqrt(mean(speeds.map((v) => (v - speedMean) ** 2))!);
  const cv = speedMean === 0 ? 1 : speedSd / speedMean;

  const summarize = (
    group: readonly WorkoutSample[],
  ): { paceSecondsPerKm: number; avgHeartRateBpm: number; ratio: number } => {
    const avgSpeed = mean(group.map((s) => s.speedMps!))!;
    const avgHr = mean(group.map((s) => s.heartRateBpm!))!;
    return {
      paceSecondsPerKm: 1000 / avgSpeed,
      avgHeartRateBpm: avgHr,
      // Speed per beat — the quantity that should stay constant if coupled.
      ratio: avgSpeed / avgHr,
    };
  };

  const firstHalf = summarize(firstSamples);
  const secondHalf = summarize(secondSamples);

  // Drift is the fall in speed-per-beat from first half to second.
  const driftPercent =
    firstHalf.ratio === 0 ? 0 : ((firstHalf.ratio - secondHalf.ratio) / firstHalf.ratio) * 100;

  if (cv > maxCv) {
    return {
      driftPercent: round(driftPercent, 1),
      firstHalf,
      secondHalf,
      isValid: false,
      invalidReason: 'Pace varied too much — drift is only meaningful on steady runs.',
      interpretation:
        'This session was not steady enough to assess aerobic decoupling. Drift is measured on continuous easy or long runs.',
    };
  }

  return {
    driftPercent: round(driftPercent, 1),
    firstHalf,
    secondHalf,
    isValid: true,
    interpretation: interpretDrift(driftPercent),
  };
}

/**
 * Interpret a drift figure.
 *
 * The conventional threshold is 5%: below that a run is considered
 * "aerobically coupled". We report possibilities rather than a cause, because
 * a single session cannot distinguish dehydration from heat from fatigue.
 */
function interpretDrift(driftPercent: number): string {
  if (driftPercent < 0) {
    return `Heart rate fell relative to pace over the run (${Math.abs(driftPercent).toFixed(1)}%). That usually means the first part was run harder than the second, or that the warm-up was still in progress early on.`;
  }
  if (driftPercent < 5) {
    return `Drift of ${driftPercent.toFixed(1)}% is within the coupled range. Your heart rate stayed proportionate to pace, which indicates good aerobic durability at this effort.`;
  }
  if (driftPercent < 10) {
    return `Drift of ${driftPercent.toFixed(1)}% is moderate. Heat, hydration, starting pace, or accumulated fatigue can each produce this — one session is not enough to separate them.`;
  }
  return `Drift of ${driftPercent.toFixed(1)}% is high. This often accompanies heat, dehydration, or an effort above true aerobic pace. Worth watching if it repeats across several runs in similar conditions.`;
}

/**
 * Derive decoupling from splits when no sample stream exists.
 * Less precise than sample-based drift but usable with Strava-style lap data.
 */
export function decouplingFromSplits(
  splits: readonly { distanceMeters: number; durationSeconds: number; avgHeartRateBpm?: number }[],
): DecouplingResult | undefined {
  const usable = splits.filter((s) => s.avgHeartRateBpm !== undefined && s.durationSeconds > 0);
  if (usable.length < 4) return undefined;

  const midpoint = Math.floor(usable.length / 2);
  const summarize = (
    group: readonly { distanceMeters: number; durationSeconds: number; avgHeartRateBpm?: number }[],
  ): { paceSecondsPerKm: number; avgHeartRateBpm: number; ratio: number } | undefined => {
    const distance = group.reduce((acc, s) => acc + s.distanceMeters, 0);
    const duration = group.reduce((acc, s) => acc + s.durationSeconds, 0);
    const avgHr = mean(group.map((s) => s.avgHeartRateBpm!));
    if (!distance || !duration || avgHr === undefined || avgHr <= 0) return undefined;
    const speed = distance / duration;
    return { paceSecondsPerKm: 1000 / speed, avgHeartRateBpm: avgHr, ratio: speed / avgHr };
  };

  const firstHalf = summarize(usable.slice(0, midpoint));
  const secondHalf = summarize(usable.slice(midpoint));
  if (!firstHalf || !secondHalf) return undefined;

  const driftPercent = ((firstHalf.ratio - secondHalf.ratio) / firstHalf.ratio) * 100;

  return {
    driftPercent: round(driftPercent, 1),
    firstHalf,
    secondHalf,
    isValid: true,
    interpretation: interpretDrift(driftPercent),
  };
}
