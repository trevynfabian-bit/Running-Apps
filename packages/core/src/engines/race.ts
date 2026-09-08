/**
 * Race goal analysis and readiness.
 *
 * Turns "I want to run a sub-50 10K on 8 November" into a set of numbers the
 * athlete can act on: the pace it requires, where they currently are, and
 * whether their training is actually pointed at it.
 *
 * Readiness is a weighted composite, not a vibe. Every factor is scored 0-100
 * with a stated basis so the athlete can see which one is holding them back.
 */

import type {
  RaceGoal,
  RacePrediction,
  RaceReadiness,
  ReadinessFactor,
} from '../domain/race.js';
import type { ConfidenceLevel } from '../domain/provenance.js';
import { clamp, round, scaleClamped } from '../util/stats.js';
import { daysBetweenLocalDates } from '../util/time.js';
import { targetPaceForGoal } from './fitness.js';

export interface RaceGoalAnalysis {
  goal: RaceGoal;
  weeksRemaining: number;
  daysRemaining: number;
  /** Pace required to hit the target, seconds per km. */
  targetPaceSecondsPerKm?: number;
  /** Current predicted finish time. */
  currentEstimateSeconds?: number;
  currentEstimatePaceSecondsPerKm?: number;
  /** Positive = currently slower than target. */
  gapSeconds?: number;
  /** Gap expressed per kilometre, which is more actionable than total time. */
  gapPaceSecondsPerKm?: number;
  confidence: ConfidenceLevel;
  /** True when the target looks out of reach in the time available. */
  targetLooksUnrealistic: boolean;
  note: string;
}

export function analyzeRaceGoal(
  goal: RaceGoal,
  prediction: RacePrediction | undefined,
  today: string,
): RaceGoalAnalysis {
  const daysRemaining = daysBetweenLocalDates(today, goal.date);
  const weeksRemaining = Math.max(0, Math.ceil(daysRemaining / 7));

  const targetPace = goal.targetDurationSeconds
    ? targetPaceForGoal(goal.distanceMeters, goal.targetDurationSeconds)
    : undefined;

  const currentEstimateSeconds = prediction?.predictedDurationSeconds;
  const gapSeconds =
    goal.targetDurationSeconds !== undefined && currentEstimateSeconds !== undefined
      ? currentEstimateSeconds - goal.targetDurationSeconds
      : undefined;

  const gapPaceSecondsPerKm =
    gapSeconds !== undefined ? (gapSeconds / goal.distanceMeters) * 1000 : undefined;

  // A rough guide to plausible improvement: trained runners rarely improve
  // more than ~1-1.5% per week of focused training, and less the fitter they
  // already are. We use 1%/week as a generous ceiling for the sanity check.
  const plausibleImprovementSeconds =
    currentEstimateSeconds !== undefined
      ? currentEstimateSeconds * 0.01 * weeksRemaining
      : undefined;

  const targetLooksUnrealistic =
    gapSeconds !== undefined &&
    plausibleImprovementSeconds !== undefined &&
    gapSeconds > plausibleImprovementSeconds;

  return {
    goal,
    weeksRemaining,
    daysRemaining,
    targetPaceSecondsPerKm: targetPace,
    currentEstimateSeconds,
    currentEstimatePaceSecondsPerKm: prediction?.predictedPaceSecondsPerKm,
    gapSeconds,
    gapPaceSecondsPerKm,
    confidence: prediction?.confidence ?? 'low',
    targetLooksUnrealistic,
    note: buildNote({
      gapSeconds,
      weeksRemaining,
      targetLooksUnrealistic,
      hasPrediction: prediction !== undefined,
      hasTarget: goal.targetDurationSeconds !== undefined,
    }),
  };
}

function buildNote(args: {
  gapSeconds?: number;
  weeksRemaining: number;
  targetLooksUnrealistic: boolean;
  hasPrediction: boolean;
  hasTarget: boolean;
}): string {
  if (!args.hasPrediction) {
    return 'Complete a few more runs — or a time trial — and a race projection will appear here.';
  }
  if (!args.hasTarget) {
    return 'No target time set. Your projection is based on your recent training.';
  }
  if (args.gapSeconds === undefined) return '';

  if (args.gapSeconds <= 0) {
    return `Your current projection is already ahead of your target with ${args.weeksRemaining} week(s) to go.`;
  }
  if (args.targetLooksUnrealistic) {
    return `Your target is ambitious for the time remaining. It is not impossible, but closing this gap in ${args.weeksRemaining} week(s) would be a fast rate of improvement. Consider a slightly softer target, or a later race.`;
  }
  return `You are within reach: the gap is closeable at a normal rate of improvement over ${args.weeksRemaining} week(s).`;
}

export interface ReadinessInputs {
  analysis: RaceGoalAnalysis;
  /** Recent weekly distance in metres, oldest first. */
  weeklyDistanceMeters: readonly number[];
  /** Longest single run completed in the last 8 weeks, metres. */
  longestRecentRunMeters?: number;
  /** Sessions completed vs planned over the last 4 weeks. */
  consistency?: { completed: number; planned: number };
  /** Sessions at or near race pace in the last 4 weeks. */
  racePaceSessionCount?: number;
}

/**
 * Score race readiness 0-100.
 *
 * Weights reflect what actually determines a race result: fitness relative to
 * the target dominates, then whether the athlete has done the volume and the
 * long runs to hold that fitness for the distance.
 */
export function computeRaceReadiness(inputs: ReadinessInputs): RaceReadiness {
  const { analysis } = inputs;
  const factors: ReadinessFactor[] = [];

  // --- Fitness gap ---------------------------------------------------------
  if (analysis.gapSeconds !== undefined && analysis.currentEstimateSeconds) {
    const relativeGap = analysis.gapSeconds / analysis.currentEstimateSeconds;
    // On target or better = 100; 10% slower than target = 0.
    const score = scaleClamped(relativeGap, 0.1, 0, 0, 100);
    factors.push({
      key: 'fitness_gap',
      label: 'Fitness vs target',
      score,
      weight: 0.35,
      detail:
        analysis.gapSeconds <= 0
          ? 'Projected ahead of target'
          : `Projected ${Math.round(analysis.gapSeconds)}s slower than target`,
    });
  } else {
    factors.push({
      key: 'fitness_gap',
      label: 'Fitness vs target',
      score: 50,
      weight: 0.35,
      detail: 'No reliable projection yet',
    });
  }

  // --- Volume --------------------------------------------------------------
  const recentWeeks = inputs.weeklyDistanceMeters.slice(-4);
  const avgWeekly = recentWeeks.length
    ? recentWeeks.reduce((a, b) => a + b, 0) / recentWeeks.length
    : 0;
  const recommendedWeekly = recommendedWeeklyVolume(analysis.goal.distanceMeters);
  const volumeScore = scaleClamped(avgWeekly / recommendedWeekly, 0.4, 1, 0, 100);
  factors.push({
    key: 'volume',
    label: 'Training volume',
    score: volumeScore,
    weight: 0.2,
    detail: `${(avgWeekly / 1000).toFixed(1)} km/week vs ~${(recommendedWeekly / 1000).toFixed(0)} km/week typical for this distance`,
  });

  // --- Long run ------------------------------------------------------------
  const requiredLongRun = requiredLongRunDistance(analysis.goal.distanceMeters);
  const longRun = inputs.longestRecentRunMeters ?? 0;
  const longRunScore = scaleClamped(longRun / requiredLongRun, 0.5, 1, 0, 100);
  factors.push({
    key: 'long_run',
    label: 'Long-run endurance',
    score: longRunScore,
    weight: 0.2,
    detail: `Longest recent run ${(longRun / 1000).toFixed(1)} km vs ~${(requiredLongRun / 1000).toFixed(0)} km target`,
  });

  // --- Consistency ---------------------------------------------------------
  if (inputs.consistency && inputs.consistency.planned > 0) {
    const rate = inputs.consistency.completed / inputs.consistency.planned;
    factors.push({
      key: 'consistency',
      label: 'Training consistency',
      score: clamp(rate * 100, 0, 100),
      weight: 0.15,
      detail: `${inputs.consistency.completed} of ${inputs.consistency.planned} planned sessions completed`,
    });
  }

  // --- Specificity ---------------------------------------------------------
  const racePaceSessions = inputs.racePaceSessionCount ?? 0;
  factors.push({
    key: 'specificity',
    label: 'Race-pace practice',
    score: scaleClamped(racePaceSessions, 0, 4, 0, 100),
    weight: 0.1,
    detail: `${racePaceSessions} session(s) at or near race pace in the last 4 weeks`,
  });

  const totalWeight = factors.reduce((acc, f) => acc + f.weight, 0);
  const score = factors.reduce((acc, f) => acc + f.score * f.weight, 0) / totalWeight;

  const weakest = [...factors].sort((a, b) => a.score - b.score)[0];

  return {
    raceGoalId: analysis.goal.id,
    score: round(score, 0),
    weeksRemaining: analysis.weeksRemaining,
    targetDurationSeconds: analysis.goal.targetDurationSeconds,
    currentEstimateDurationSeconds: analysis.currentEstimateSeconds,
    gapSeconds: analysis.gapSeconds,
    confidence: analysis.confidence,
    factors: factors.sort((a, b) => b.weight - a.weight),
    summary: `${Math.round(score)}% ready with ${analysis.weeksRemaining} week(s) to go.${
      weakest ? ` Your biggest opportunity is ${weakest.label.toLowerCase()} — ${weakest.detail}.` : ''
    }`,
  };
}

/** Rough weekly volume typical of runners racing a given distance well. */
function recommendedWeeklyVolume(raceDistanceMeters: number): number {
  if (raceDistanceMeters <= 5000) return 30_000;
  if (raceDistanceMeters <= 10_000) return 40_000;
  if (raceDistanceMeters <= 21_100) return 55_000;
  return 70_000;
}

/** Long run distance that supports racing a given distance. */
function requiredLongRunDistance(raceDistanceMeters: number): number {
  if (raceDistanceMeters <= 5000) return 10_000;
  if (raceDistanceMeters <= 10_000) return 14_000;
  if (raceDistanceMeters <= 21_100) return 18_000;
  // Most marathon plans top out around 32 km rather than the full distance.
  return 30_000;
}
