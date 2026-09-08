/**
 * Training load.
 *
 * "Training load" is not one number with one correct formula — it is a family
 * of models that each approximate internal stress from different evidence.
 * This engine picks the best model the available data supports, and always
 * records WHICH model was used so two sessions computed differently are never
 * silently compared as if they were the same measurement.
 *
 * Session load models, in order of preference
 * -------------------------------------------
 * 1. `trimp_hr`   Banister TRIMP with the Morton/Edwards exponential weighting.
 *                 Uses heart-rate reserve, so it needs max HR and resting HR.
 *                 Sex-specific exponential coefficients (1.92 male / 1.67
 *                 female) come from the original literature; the unspecified
 *                 case uses the midpoint rather than defaulting to either.
 *
 * 2. `hr_zone`    Zone-weighted duration, when we have HR samples but not a
 *                 reliable resting HR. Coarser than TRIMP but robust.
 *
 * 3. `srpe`       Foster's session-RPE: duration in minutes × RPE (1-10).
 *                 Requires only athlete input, works when no HR exists at all,
 *                 and correlates well with HR-based measures in practice.
 *
 * 4. `duration`   Duration × a fixed intensity factor inferred from workout
 *                 type. The last resort; flagged as low confidence.
 *
 * The models produce numbers on deliberately similar scales (roughly
 * "one easy hour ≈ 50") so a mixed history is still usable for trends, but
 * the `model` field lets the UI caveat any comparison.
 *
 * Chronic / acute load
 * --------------------
 * Acute (7-day) and chronic (28-day) exponentially weighted averages, and
 * their ratio (ACWR). ACWR is widely used and widely criticised: the evidence
 * for a universal "danger zone" above 1.5 is weak, and the ratio is unstable
 * when chronic load is low. We therefore treat it as ONE input among many in
 * the decision engine, expose it only in the detail view, and suppress it
 * entirely until there is enough history for it to mean anything.
 */

import type { CanonicalWorkout, WorkoutType } from '../domain/workout.js';
import type { BiologicalSex } from '../domain/athlete.js';
import type { ZoneSet } from './zones.js';
import { zoneDistribution } from './zones.js';
import { clamp, ewma, mean, stdDev, sum } from '../util/stats.js';
import { addDaysToLocalDate, daysBetweenLocalDates, toLocalDate } from '../util/time.js';

export type LoadModel = 'trimp_hr' | 'hr_zone' | 'srpe' | 'duration';

export interface SessionLoad {
  workoutId: string;
  /** Local date the session is attributed to. */
  date: string;
  load: number;
  model: LoadModel;
  /** 0..1 — how much we trust this figure. */
  confidence: number;
  /** Human-readable explanation of the computation. */
  basis: string;
}

export interface LoadInputs {
  maxHeartRateBpm?: number;
  restingHeartRateBpm?: number;
  sex: BiologicalSex;
  zoneSet?: ZoneSet;
}

/**
 * Intensity factors by workout type, used only by the `duration` fallback.
 * Roughly "fraction of threshold intensity".
 */
const TYPE_INTENSITY: Record<WorkoutType, number> = {
  recovery: 0.5,
  easy: 0.6,
  long: 0.68,
  progression: 0.75,
  treadmill: 0.62,
  fartlek: 0.8,
  strides: 0.7,
  tempo: 0.85,
  threshold: 0.9,
  hills: 0.9,
  intervals: 0.95,
  race_simulation: 0.95,
  time_trial: 1.0,
  race: 1.0,
  cross_training: 0.55,
  strength: 0.5,
  rest: 0,
};

/** Zone weights for the `hr_zone` model — superlinear, as intensity cost is. */
const ZONE_WEIGHTS = [0.5, 1.0, 1.7, 2.6, 3.6];

/**
 * Banister TRIMP.
 *
 * load = duration_min × HRR_fraction × 0.64 × e^(k × HRR_fraction)
 * where HRR_fraction = (HR_avg − HR_rest) / (HR_max − HR_rest).
 */
export function trimp(
  durationMinutes: number,
  avgHeartRateBpm: number,
  maxHeartRateBpm: number,
  restingHeartRateBpm: number,
  sex: BiologicalSex,
): number | undefined {
  const reserve = maxHeartRateBpm - restingHeartRateBpm;
  if (reserve <= 0 || durationMinutes <= 0) return undefined;

  const fraction = clamp((avgHeartRateBpm - restingHeartRateBpm) / reserve, 0, 1.2);
  if (fraction <= 0) return 0;

  // Sex-specific weighting from the Banister/Morton formulation. The
  // 'unspecified' case takes the midpoint rather than silently assuming male.
  const k = sex === 'male' ? 1.92 : sex === 'female' ? 1.67 : 1.795;

  return durationMinutes * fraction * 0.64 * Math.exp(k * fraction);
}

/** Foster session-RPE: minutes × RPE. Rescaled to sit near the TRIMP range. */
export function sessionRpeLoad(durationMinutes: number, rpe: number): number {
  // Raw sRPE (min × RPE) runs ~5× higher than TRIMP for the same session;
  // dividing by 5 puts the two models on a comparable scale.
  return (durationMinutes * clamp(rpe, 1, 10)) / 5;
}

/**
 * Compute the load for a single workout, choosing the best available model.
 */
export function computeSessionLoad(
  workout: CanonicalWorkout,
  inputs: LoadInputs,
): SessionLoad | undefined {
  const date = toLocalDate(workout.startTime, workout.timezone);
  const seconds = workout.movingTimeSeconds ?? workout.durationSeconds;
  if (!seconds || seconds <= 0) return undefined;

  const minutes = seconds / 60;

  if (workout.type === 'rest') {
    return { workoutId: workout.id, date, load: 0, model: 'duration', confidence: 1, basis: 'Rest day.' };
  }

  // --- 1. TRIMP ------------------------------------------------------------
  if (
    workout.avgHeartRateBpm !== undefined &&
    inputs.maxHeartRateBpm !== undefined &&
    inputs.restingHeartRateBpm !== undefined
  ) {
    const value = trimp(
      minutes,
      workout.avgHeartRateBpm,
      inputs.maxHeartRateBpm,
      inputs.restingHeartRateBpm,
      inputs.sex,
    );
    if (value !== undefined) {
      return {
        workoutId: workout.id,
        date,
        load: value,
        model: 'trimp_hr',
        confidence: 0.9,
        basis: `TRIMP from ${Math.round(minutes)} min at ${workout.avgHeartRateBpm} bpm average.`,
      };
    }
  }

  // --- 2. Zone-weighted duration ------------------------------------------
  if (inputs.zoneSet?.kind === 'heart_rate' && workout.samples?.length) {
    const distribution = zoneDistribution(inputs.zoneSet, workout.samples);
    const total = sum(distribution);
    if (total > 0) {
      const weighted = distribution.reduce(
        (acc, share, index) => acc + share * (ZONE_WEIGHTS[index] ?? 1),
        0,
      );
      return {
        workoutId: workout.id,
        date,
        load: minutes * weighted,
        model: 'hr_zone',
        confidence: 0.75,
        basis: `Zone-weighted from ${workout.samples.length} heart-rate samples over ${Math.round(minutes)} min.`,
      };
    }
  }

  // --- 3. Session RPE ------------------------------------------------------
  if (workout.perceivedExertion !== undefined) {
    return {
      workoutId: workout.id,
      date,
      load: sessionRpeLoad(minutes, workout.perceivedExertion),
      model: 'srpe',
      confidence: 0.65,
      basis: `Session RPE ${workout.perceivedExertion}/10 over ${Math.round(minutes)} min.`,
    };
  }

  // --- 4. Duration × type intensity ---------------------------------------
  const intensity = TYPE_INTENSITY[workout.type] ?? 0.6;
  return {
    workoutId: workout.id,
    date,
    load: minutes * intensity * 1.2,
    model: 'duration',
    confidence: 0.4,
    basis: `Estimated from ${Math.round(minutes)} min of ${workout.type.replace(/_/g, ' ')} — no heart-rate or effort data.`,
  };
}

// ---------------------------------------------------------------------------
// Aggregated load state
// ---------------------------------------------------------------------------

export interface TrainingLoadState {
  date: string;
  /** Exponentially weighted 7-day load ("fatigue"). */
  acuteLoad: number;
  /** Exponentially weighted 28-day load ("fitness"). */
  chronicLoad: number;
  /**
   * Acute:chronic ratio. Undefined until there is enough chronic history for
   * the ratio to be meaningful — a near-zero denominator produces nonsense.
   */
  acuteChronicRatio?: number;
  /** Chronic minus acute; positive suggests freshness. */
  trainingStressBalance: number;
  /** Weekly load total for the trailing 7 days. */
  weeklyLoad: number;
  /**
   * Monotony (Foster): mean daily load / SD of daily load over 7 days.
   * High monotony means every day looks the same, which is associated with
   * poorer adaptation even at moderate volume.
   */
  monotony?: number;
  /** Strain: weekly load × monotony. */
  strain?: number;
  /** 0..1 — proportion of the window with actual data. */
  dataCompleteness: number;
  /** Days of history available, for gating what the UI shows. */
  historyDays: number;
}

export interface DailyLoad {
  date: string;
  load: number;
}

/**
 * Roll session loads up into a dense daily series, filling gaps with zeros.
 * Rest days are real training information and must not be skipped.
 */
export function toDailySeries(
  sessions: readonly SessionLoad[],
  from: string,
  to: string,
): DailyLoad[] {
  const byDate = new Map<string, number>();
  for (const session of sessions) {
    byDate.set(session.date, (byDate.get(session.date) ?? 0) + session.load);
  }

  const out: DailyLoad[] = [];
  const span = daysBetweenLocalDates(from, to);
  for (let i = 0; i <= span; i++) {
    const date = addDaysToLocalDate(from, i);
    out.push({ date, load: byDate.get(date) ?? 0 });
  }
  return out;
}

/**
 * Compute the aggregate load state as of the final day of the series.
 */
export function computeTrainingLoadState(
  daily: readonly DailyLoad[],
  options: { minChronicDaysForRatio?: number } = {},
): TrainingLoadState | undefined {
  if (daily.length === 0) return undefined;

  const minChronicDays = options.minChronicDaysForRatio ?? 21;
  const series = daily.map((d) => d.load);
  const last = daily[daily.length - 1]!;

  const acuteLoad = ewma(series.slice(-7), 7) ?? 0;
  const chronicLoad = ewma(series.slice(-28), 28) ?? 0;

  const trailingWeek = daily.slice(-7);
  const weeklyLoad = sum(trailingWeek.map((d) => d.load));

  // Monotony needs variance; a week of identical days (or one day) is degenerate.
  const weekLoads = trailingWeek.map((d) => d.load);
  const weekMean = mean(weekLoads);
  const weekSd = stdDev(weekLoads);
  let monotony: number | undefined;
  let strain: number | undefined;
  if (trailingWeek.length >= 7 && weekMean !== undefined && weekSd !== undefined && weekSd > 0.01) {
    monotony = weekMean / weekSd;
    strain = weeklyLoad * monotony;
  }

  // ACWR is only meaningful with a real chronic base behind it.
  const daysWithLoad = daily.filter((d) => d.load > 0).length;
  const acuteChronicRatio =
    daily.length >= minChronicDays && chronicLoad > 1 && daysWithLoad >= 8
      ? acuteLoad / chronicLoad
      : undefined;

  return {
    date: last.date,
    acuteLoad,
    chronicLoad,
    acuteChronicRatio,
    trainingStressBalance: chronicLoad - acuteLoad,
    weeklyLoad,
    monotony,
    strain,
    dataCompleteness: daily.length === 0 ? 0 : daysWithLoad / daily.length,
    historyDays: daily.length,
  };
}

/**
 * Intensity distribution over a set of workouts: the share of running TIME
 * spent easy / moderate / hard.
 *
 * Polarised and pyramidal training models both depend on keeping the easy
 * share high (typically ≥ 75-80%). This is one of the most actionable
 * diagnostics the app can show, because the most common self-coached error is
 * running easy days too hard.
 */
export interface IntensityDistribution {
  easyShare: number;
  moderateShare: number;
  hardShare: number;
  totalSeconds: number;
  /** True when the easy share is below the conventional 75% guideline. */
  easyShareBelowGuideline: boolean;
}

export function computeIntensityDistribution(
  workouts: readonly CanonicalWorkout[],
  zoneSet?: ZoneSet,
): IntensityDistribution | undefined {
  let easy = 0;
  let moderate = 0;
  let hard = 0;

  for (const workout of workouts) {
    const seconds = workout.movingTimeSeconds ?? workout.durationSeconds;
    if (!seconds || seconds <= 0 || workout.type === 'rest') continue;

    // Prefer real HR sample distribution; fall back to workout type.
    if (zoneSet?.kind === 'heart_rate' && workout.samples?.length) {
      const distribution = zoneDistribution(zoneSet, workout.samples);
      easy += seconds * ((distribution[0] ?? 0) + (distribution[1] ?? 0));
      moderate += seconds * (distribution[2] ?? 0);
      hard += seconds * ((distribution[3] ?? 0) + (distribution[4] ?? 0));
      continue;
    }

    const intensity = TYPE_INTENSITY[workout.type] ?? 0.6;
    if (intensity <= 0.7) easy += seconds;
    else if (intensity <= 0.85) moderate += seconds;
    else hard += seconds;
  }

  const total = easy + moderate + hard;
  if (total === 0) return undefined;

  const easyShare = easy / total;
  return {
    easyShare,
    moderateShare: moderate / total,
    hardShare: hard / total,
    totalSeconds: total,
    easyShareBelowGuideline: easyShare < 0.75,
  };
}
