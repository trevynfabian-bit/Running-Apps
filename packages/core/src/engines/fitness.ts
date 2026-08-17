/**
 * Running fitness estimation and race prediction.
 *
 * Everything in this file produces an ESTIMATE. None of it is a laboratory
 * measurement, and the UI is required to label it as such. The models are
 * published, widely used, and — importantly — have known failure modes that
 * are documented here so the confidence values mean something.
 *
 * Models
 * ------
 * Riegel (1977)   T2 = T1 × (D2 / D1) ^ 1.06
 *                 An empirical fatigue law fitted to race results. The 1.06
 *                 exponent is a population average; well-trained athletes with
 *                 high endurance sit lower (~1.04), under-trained athletes
 *                 higher (~1.10). Accuracy degrades badly when extrapolating
 *                 far beyond the source distance — a 5K time predicts a
 *                 marathon poorly because the marathon is limited by fuelling
 *                 and durability, not just aerobic power. We therefore
 *                 penalise confidence by extrapolation ratio.
 *
 * VDOT-style      Daniels & Gilbert's velocity/oxygen-cost relationship,
 *                 giving a single fitness number comparable across distances.
 *                 We implement the published VO2 and %max curves, then invert
 *                 numerically to get a pseudo-VO2max ("VDOT"). This is an
 *                 estimate of *running economy plus aerobic capacity*, not a
 *                 measured VO2max, and it is labelled accordingly.
 *
 * Threshold pace  Derived either from a sustained threshold effort or from
 *                 VDOT. Threshold is the most useful single anchor for
 *                 prescribing training, so it gets its own estimate.
 */

import type { RaceResult } from '../domain/athlete.js';
import type { RacePrediction, PredictionMethod } from '../domain/race.js';
import type { ConfidenceLevel } from '../domain/provenance.js';
import { clamp, mean } from '../util/stats.js';
import { daysBetweenLocalDates } from '../util/time.js';

/** Riegel exponent. 1.06 is the classic population value. */
export const RIEGEL_EXPONENT = 1.06;

/**
 * Predict a time at `targetDistance` from a known performance, via Riegel.
 */
export function riegelPredict(
  knownDistanceMeters: number,
  knownDurationSeconds: number,
  targetDistanceMeters: number,
  exponent: number = RIEGEL_EXPONENT,
): number | undefined {
  if (knownDistanceMeters <= 0 || knownDurationSeconds <= 0 || targetDistanceMeters <= 0) {
    return undefined;
  }
  return knownDurationSeconds * (targetDistanceMeters / knownDistanceMeters) ** exponent;
}

// ---------------------------------------------------------------------------
// VDOT (Daniels & Gilbert)
// ---------------------------------------------------------------------------

/**
 * Oxygen cost of running at a given velocity (ml/kg/min).
 * Daniels & Gilbert: VO2 = -4.60 + 0.182258·v + 0.000104·v²  (v in m/min)
 */
export function oxygenCost(velocityMetersPerMinute: number): number {
  return -4.6 + 0.182258 * velocityMetersPerMinute + 0.000104 * velocityMetersPerMinute ** 2;
}

/**
 * Fraction of VO2max sustainable for a given duration.
 * Daniels & Gilbert: %max = 0.8 + 0.1894393·e^(-0.012778·t) + 0.2989558·e^(-0.1932605·t)
 * with t in minutes.
 */
export function percentOfMax(durationMinutes: number): number {
  return (
    0.8 +
    0.1894393 * Math.exp(-0.012778 * durationMinutes) +
    0.2989558 * Math.exp(-0.1932605 * durationMinutes)
  );
}

/**
 * Raw VDOT arithmetic with no validity gates.
 *
 * Internal only. `predictFromVdot` bisects across deliberately extreme
 * durations that fall outside the range of a plausible real performance, so it
 * needs the unclamped curve — gating here would make the bracket endpoints
 * return undefined and abort the search.
 */
function rawVdot(distanceMeters: number, durationSeconds: number): number | undefined {
  if (distanceMeters <= 0 || durationSeconds <= 0) return undefined;
  const minutes = durationSeconds / 60;
  const velocity = distanceMeters / minutes;
  const fraction = percentOfMax(minutes);
  if (fraction <= 0) return undefined;
  return oxygenCost(velocity) / fraction;
}

/**
 * Shortest effort the Daniels model is meaningful for.
 * Below ~3 minutes performance is dominated by anaerobic capacity and
 * running economy at speed, which this model does not describe — a 20-second
 * sprint would otherwise yield a confident, entirely fictional VDOT.
 */
const MIN_VALID_EFFORT_SECONDS = 180;
/** Beyond ~4 hours, fuelling and durability dominate rather than aerobic power. */
const MAX_VALID_EFFORT_SECONDS = 4 * 3600;
const MIN_VALID_EFFORT_METERS = 1000;

/**
 * VDOT implied by a race performance: the oxygen cost of the race velocity
 * divided by the fraction of max sustainable for that duration.
 *
 * Returns undefined for efforts the model does not describe, rather than
 * producing a plausible-looking number from an inapplicable input.
 */
export function vdotFromPerformance(
  distanceMeters: number,
  durationSeconds: number,
): number | undefined {
  if (distanceMeters < MIN_VALID_EFFORT_METERS) return undefined;
  if (durationSeconds < MIN_VALID_EFFORT_SECONDS) return undefined;
  if (durationSeconds > MAX_VALID_EFFORT_SECONDS) return undefined;

  const vdot = rawVdot(distanceMeters, durationSeconds);
  if (vdot === undefined) return undefined;

  // Outside this band the input is not a sustained running effort at all.
  return vdot > 15 && vdot < 90 ? vdot : undefined;
}

/**
 * Invert the VDOT relationship: the time this VDOT implies at a distance.
 *
 * There's no closed form, so we bisect on duration. The function is monotonic
 * in duration over the relevant range, which makes bisection safe and fast.
 */
export function predictFromVdot(
  vdot: number,
  distanceMeters: number,
  toleranceSeconds = 0.5,
): number | undefined {
  if (vdot <= 0 || distanceMeters <= 0) return undefined;

  // Bracket: 1.5 min/km (elite) to 12 min/km (walking) gives a generous range.
  let low = (distanceMeters / 1000) * 90;
  let high = (distanceMeters / 1000) * 720;

  // Bisect on the ungated curve: the bracket endpoints are intentionally
  // extreme and would be rejected by the public function's validity gates.
  const impliedVdot = (durationSeconds: number): number | undefined =>
    rawVdot(distanceMeters, durationSeconds);

  // Guard against a bracket that doesn't contain the answer.
  const lowVdot = impliedVdot(low);
  const highVdot = impliedVdot(high);
  if (lowVdot === undefined || highVdot === undefined) return undefined;
  if (vdot > lowVdot || vdot < highVdot) return undefined;

  for (let i = 0; i < 100 && high - low > toleranceSeconds; i++) {
    const mid = (low + high) / 2;
    const midVdot = impliedVdot(mid);
    if (midVdot === undefined) return undefined;
    // Faster time => higher implied VDOT, so search downward when we're low.
    if (midVdot > vdot) low = mid;
    else high = mid;
  }

  return (low + high) / 2;
}

/**
 * Threshold pace from VDOT.
 *
 * Threshold effort corresponds to roughly 83-88% of VO2max for trained
 * runners; we use 86%, the midpoint of Daniels' "T pace" band, and solve the
 * oxygen-cost curve for the matching velocity.
 */
export function thresholdPaceFromVdot(vdot: number): number | undefined {
  if (vdot <= 0) return undefined;
  const targetCost = 0.86 * vdot;

  // Solve -4.6 + 0.182258v + 0.000104v² = targetCost for v (m/min).
  const a = 0.000104;
  const b = 0.182258;
  const c = -4.6 - targetCost;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return undefined;

  const velocity = (-b + Math.sqrt(discriminant)) / (2 * a);
  if (velocity <= 0) return undefined;

  // m/min -> seconds per km
  return 60 / (velocity / 1000);
}

/**
 * Easy/aerobic pace band from VDOT: roughly 59-74% of VO2max.
 * Returned as [fastSecondsPerKm, slowSecondsPerKm].
 */
export function easyPaceRangeFromVdot(vdot: number): [number, number] | undefined {
  const solve = (fraction: number): number | undefined => {
    const targetCost = fraction * vdot;
    const a = 0.000104;
    const b = 0.182258;
    const c = -4.6 - targetCost;
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return undefined;
    const velocity = (-b + Math.sqrt(discriminant)) / (2 * a);
    if (velocity <= 0) return undefined;
    return 60 / (velocity / 1000);
  };

  const fast = solve(0.74);
  const slow = solve(0.59);
  if (fast === undefined || slow === undefined) return undefined;
  return [fast, slow];
}

// ---------------------------------------------------------------------------
// Fitness snapshot
// ---------------------------------------------------------------------------

export interface FitnessEstimate {
  /** Daniels-style VDOT. An estimate of aerobic fitness, NOT a measured VO2max. */
  vdot?: number;
  /** Same number, surfaced with an explicitly estimated label in the UI. */
  estimatedVo2Max?: number;
  thresholdPaceSecondsPerKm?: number;
  easyPaceRangeSecondsPerKm?: [number, number];
  confidence: ConfidenceLevel;
  /** Which performance(s) this was built from. */
  basis: string;
  /** Local date of the most recent input performance. */
  asOfDate?: string;
}

/**
 * A performance good enough to estimate fitness from: a race, a time trial,
 * or a hard sustained effort detected in training.
 */
export interface FitnessInput {
  distanceMeters: number;
  durationSeconds: number;
  /** Local date `YYYY-MM-DD`. */
  date: string;
  source: 'race' | 'time_trial' | 'self_reported' | 'detected_effort';
}

/**
 * Weight a performance by how recent it is.
 * Fitness decays and improves over weeks, so a 6-month-old 5K says much less
 * about today than last week's does. Half-life of ~8 weeks.
 */
function recencyWeight(date: string, today: string): number {
  const ageDays = Math.max(0, daysBetweenLocalDates(date, today));
  return Math.exp((-Math.LN2 * ageDays) / 56);
}

/** Source quality weight: an actual race is stronger evidence than a claim. */
function sourceWeight(source: FitnessInput['source']): number {
  switch (source) {
    case 'race':
      return 1;
    case 'time_trial':
      return 0.9;
    case 'detected_effort':
      return 0.6;
    case 'self_reported':
      return 0.5;
  }
}

/**
 * Estimate current fitness from the athlete's performance history.
 *
 * Combines VDOT estimates from each qualifying performance, weighted by
 * recency and source quality. Very short (<1500 m) and very long (>marathon)
 * efforts are excluded: the model is poorly behaved at both extremes.
 */
export function estimateFitness(
  inputs: readonly FitnessInput[],
  today: string,
): FitnessEstimate {
  const usable = inputs.filter(
    (i) =>
      i.distanceMeters >= 1500 &&
      i.distanceMeters <= 42500 &&
      i.durationSeconds > 0 &&
      // Ignore anything older than a year outright.
      daysBetweenLocalDates(i.date, today) <= 365 &&
      daysBetweenLocalDates(i.date, today) >= 0,
  );

  if (usable.length === 0) {
    return {
      confidence: 'low',
      basis: 'No recent race, time trial or hard sustained effort available.',
    };
  }

  const scored = usable
    .map((input) => {
      const vdot = vdotFromPerformance(input.distanceMeters, input.durationSeconds);
      if (vdot === undefined) return undefined;
      return { input, vdot, weight: recencyWeight(input.date, today) * sourceWeight(input.source) };
    })
    .filter((v): v is { input: FitnessInput; vdot: number; weight: number } => v !== undefined);

  if (scored.length === 0) {
    return {
      confidence: 'low',
      basis: 'Available performances fall outside the range the model supports.',
    };
  }

  const totalWeight = scored.reduce((acc, s) => acc + s.weight, 0);
  const vdot = scored.reduce((acc, s) => acc + s.vdot * s.weight, 0) / totalWeight;

  // Newest performance anchors the "as of" date shown to the athlete.
  const newest = scored.reduce((best, s) =>
    daysBetweenLocalDates(s.input.date, today) < daysBetweenLocalDates(best.input.date, today)
      ? s
      : best,
  );

  const confidence = fitnessConfidence(scored, today);

  return {
    vdot,
    estimatedVo2Max: vdot,
    thresholdPaceSecondsPerKm: thresholdPaceFromVdot(vdot),
    easyPaceRangeSecondsPerKm: easyPaceRangeFromVdot(vdot),
    confidence,
    basis: describeBasis(scored.map((s) => s.input), newest.input),
    asOfDate: newest.input.date,
  };
}

function describeBasis(inputs: readonly FitnessInput[], newest: FitnessInput): string {
  const km = (newest.distanceMeters / 1000).toFixed(newest.distanceMeters < 10000 ? 1 : 0);
  const label =
    newest.source === 'race'
      ? 'race'
      : newest.source === 'time_trial'
        ? 'time trial'
        : newest.source === 'detected_effort'
          ? 'hard effort'
          : 'self-reported time';
  if (inputs.length === 1) return `From your ${km} km ${label} on ${newest.date}.`;
  return `From ${inputs.length} performances, most recently your ${km} km ${label} on ${newest.date}.`;
}

/**
 * Confidence in a fitness estimate.
 * Driven by how recent the evidence is, how much of it there is, and whether
 * the individual estimates agree with each other.
 */
function fitnessConfidence(
  scored: readonly { input: FitnessInput; vdot: number; weight: number }[],
  today: string,
): ConfidenceLevel {
  const freshestAgeDays = Math.min(
    ...scored.map((s) => daysBetweenLocalDates(s.input.date, today)),
  );
  const hasRealPerformance = scored.some(
    (s) => s.input.source === 'race' || s.input.source === 'time_trial',
  );

  const values = scored.map((s) => s.vdot);
  const avg = mean(values) ?? 0;
  const spread = values.length > 1 ? (Math.max(...values) - Math.min(...values)) / avg : 0;

  if (freshestAgeDays <= 42 && hasRealPerformance && spread < 0.08) return 'high';
  if (freshestAgeDays <= 90 && (hasRealPerformance || scored.length >= 2)) return 'moderate';
  return 'low';
}

// ---------------------------------------------------------------------------
// Race prediction
// ---------------------------------------------------------------------------

/**
 * Predict a race time at a distance, blending Riegel and VDOT.
 *
 * The two models disagree most at the extremes; averaging them is more robust
 * than trusting either, and the disagreement itself is a useful confidence
 * signal (large disagreement ⇒ we're extrapolating too far).
 */
export function predictRace(
  targetDistanceMeters: number,
  fitness: FitnessEstimate,
  bestRecentPerformance: FitnessInput | undefined,
  today: string,
): RacePrediction | undefined {
  if (targetDistanceMeters <= 0) return undefined;

  const estimates: { seconds: number; method: PredictionMethod }[] = [];

  if (fitness.vdot !== undefined) {
    const seconds = predictFromVdot(fitness.vdot, targetDistanceMeters);
    if (seconds !== undefined) estimates.push({ seconds, method: 'vdot' });
  }

  if (bestRecentPerformance) {
    const seconds = riegelPredict(
      bestRecentPerformance.distanceMeters,
      bestRecentPerformance.durationSeconds,
      targetDistanceMeters,
    );
    if (seconds !== undefined) estimates.push({ seconds, method: 'riegel' });
  }

  if (estimates.length === 0) return undefined;

  const predictedDurationSeconds = mean(estimates.map((e) => e.seconds))!;
  const method: PredictionMethod = estimates.length > 1 ? 'blended' : estimates[0]!.method;

  // Downgrade confidence when extrapolating far from the evidence, or when the
  // two models disagree substantially.
  let confidence = fitness.confidence;

  if (bestRecentPerformance) {
    const ratio =
      Math.max(targetDistanceMeters, bestRecentPerformance.distanceMeters) /
      Math.min(targetDistanceMeters, bestRecentPerformance.distanceMeters);
    if (ratio > 4) confidence = downgrade(downgrade(confidence));
    else if (ratio > 2.5) confidence = downgrade(confidence);
  }

  if (estimates.length > 1) {
    const spread =
      (Math.max(...estimates.map((e) => e.seconds)) -
        Math.min(...estimates.map((e) => e.seconds))) /
      predictedDurationSeconds;
    if (spread > 0.08) confidence = downgrade(confidence);
  }

  return {
    distanceMeters: targetDistanceMeters,
    predictedDurationSeconds,
    predictedPaceSecondsPerKm: (predictedDurationSeconds / targetDistanceMeters) * 1000,
    confidence,
    method,
    basis: bestRecentPerformance
      ? `${describeShort(bestRecentPerformance)} on ${bestRecentPerformance.date}${
          fitness.vdot ? ` and estimated VDOT ${fitness.vdot.toFixed(1)}` : ''
        }`
      : `estimated VDOT ${fitness.vdot?.toFixed(1) ?? '—'} as of ${fitness.asOfDate ?? today}`,
  };
}

function describeShort(input: FitnessInput): string {
  const km = input.distanceMeters / 1000;
  return `${km < 10 ? km.toFixed(1) : km.toFixed(0)} km ${
    input.source === 'race' ? 'race' : input.source === 'time_trial' ? 'time trial' : 'effort'
  }`;
}

function downgrade(level: ConfidenceLevel): ConfidenceLevel {
  return level === 'high' ? 'moderate' : 'low';
}

/** Convert stored race results into fitness inputs. */
export function raceResultsToFitnessInputs(results: readonly RaceResult[]): FitnessInput[] {
  return results.map((r) => ({
    distanceMeters: r.distanceMeters,
    durationSeconds: r.durationSeconds,
    date: r.date,
    source:
      r.source === 'detected' ? 'detected_effort' : r.source === 'time_trial' ? 'time_trial' : 'self_reported',
  }));
}

/** Target pace needed to hit a goal time at a distance. */
export function targetPaceForGoal(
  distanceMeters: number,
  targetDurationSeconds: number,
): number | undefined {
  if (distanceMeters <= 0 || targetDurationSeconds <= 0) return undefined;
  return (targetDurationSeconds / distanceMeters) * 1000;
}

/** Estimated threshold HR as a fraction of max HR, when no measurement exists. */
export function estimateThresholdHeartRate(maxHeartRateBpm: number): number {
  // Threshold typically sits near 88-92% of max HR in trained runners.
  return Math.round(clamp(0.9 * maxHeartRateBpm, 100, maxHeartRateBpm - 5));
}
