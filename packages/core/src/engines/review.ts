/**
 * Weekly and block reviews.
 *
 * Reviews are generated deterministically from the week's data so the athlete
 * gets the same assessment whether or not the AI layer is available. The LLM
 * can rephrase these, but the judgements and numbers originate here.
 */

import type { CanonicalWorkout } from '../domain/workout.js';
import { isHardType } from '../domain/workout.js';
import type { PlannedWorkout } from '../domain/workout.js';
import type { TrainingBlock, WeeklySummary } from '../domain/training.js';
import type { RecoveryState } from '../domain/recovery.js';
import type { SessionLoad, IntensityDistribution } from './load.js';
import type { EfficiencyTrend } from './efficiency.js';
import { mean, percentChange, round, sum } from '../util/stats.js';
import { isoWeekKey, startOfWeek, toLocalDate } from '../util/time.js';

// ---------------------------------------------------------------------------
// Weekly summary
// ---------------------------------------------------------------------------

export function buildWeeklySummary(args: {
  weekStart: string;
  completed: readonly CanonicalWorkout[];
  planned: readonly PlannedWorkout[];
  loads: readonly SessionLoad[];
  intensityDistribution?: IntensityDistribution;
}): WeeklySummary {
  const { weekStart, completed, planned, loads } = args;

  const runs = completed.filter((w) => w.sport === 'run');
  const completedDistance = sum(runs.map((w) => w.distanceMeters ?? 0));
  const plannedDistance = sum(planned.map((w) => w.targetDistanceMeters ?? 0));

  return {
    weekKey: isoWeekKey(weekStart),
    weekStart,
    plannedDistanceMeters: Math.round(plannedDistance),
    completedDistanceMeters: Math.round(completedDistance),
    plannedSessions: planned.filter((w) => w.type !== 'rest').length,
    completedSessions: runs.length,
    longestRunMeters: Math.round(Math.max(0, ...runs.map((w) => w.distanceMeters ?? 0))),
    qualitySessions: runs.filter((w) => isHardType(w.type)).length,
    totalTrainingLoad: round(sum(loads.map((l) => l.load)), 1),
    totalDurationSeconds: Math.round(
      sum(runs.map((w) => w.movingTimeSeconds ?? w.durationSeconds ?? 0)),
    ),
    highIntensityShare: args.intensityDistribution?.hardShare,
  };
}

export type WeeklyAssessment =
  | 'excellent_progression'
  | 'good_progression'
  | 'steady'
  | 'below_plan'
  | 'significantly_below_plan'
  | 'overreaching';

export interface WeeklyReview {
  weekKey: string;
  weekStart: string;
  summary: WeeklySummary;
  /** Percent change in distance vs the previous week. */
  distanceChangePercent?: number;
  completionRate: number;
  averageRecoveryScore?: number;
  averageSleepSeconds?: number;
  assessment: WeeklyAssessment;
  headline: string;
  whatWentWell: string[];
  whatNeedsAttention: string[];
  keyAdaptation: string;
  nextWeekPriority: string;
}

export function buildWeeklyReview(args: {
  summary: WeeklySummary;
  previousSummary?: WeeklySummary;
  recoveryStates: readonly RecoveryState[];
  sleepSecondsByDay: readonly number[];
  efficiencyTrend?: EfficiencyTrend;
  intensityDistribution?: IntensityDistribution;
  isDeloadWeek?: boolean;
}): WeeklyReview {
  const { summary, previousSummary, recoveryStates, sleepSecondsByDay } = args;

  const distanceChangePercent = previousSummary
    ? percentChange(previousSummary.completedDistanceMeters, summary.completedDistanceMeters)
    : undefined;

  const completionRate =
    summary.plannedSessions > 0 ? summary.completedSessions / summary.plannedSessions : 1;

  const averageRecoveryScore = mean(recoveryStates.map((r) => r.score));
  const averageSleepSeconds = mean([...sleepSecondsByDay]);

  const whatWentWell: string[] = [];
  const whatNeedsAttention: string[] = [];

  // --- Consistency ---------------------------------------------------------
  if (completionRate >= 0.9) {
    whatWentWell.push(
      `You completed ${summary.completedSessions} of ${summary.plannedSessions} planned sessions.`,
    );
  } else if (completionRate < 0.6) {
    whatNeedsAttention.push(
      `Only ${summary.completedSessions} of ${summary.plannedSessions} planned sessions were completed. Consistency drives more of your progress than any single workout.`,
    );
  }

  // --- Volume --------------------------------------------------------------
  if (distanceChangePercent !== undefined) {
    if (distanceChangePercent > 25 && !args.isDeloadWeek) {
      whatNeedsAttention.push(
        `Weekly distance jumped ${Math.round(distanceChangePercent)}%. Large single-week increases carry more injury risk than they add fitness.`,
      );
    } else if (distanceChangePercent > 5 && distanceChangePercent <= 15) {
      whatWentWell.push(
        `Weekly distance rose ${Math.round(distanceChangePercent)}% — a sustainable rate of progression.`,
      );
    } else if (distanceChangePercent < -25 && !args.isDeloadWeek) {
      whatNeedsAttention.push(
        `Weekly distance dropped ${Math.round(Math.abs(distanceChangePercent))}%.`,
      );
    }
  }

  if (args.isDeloadWeek) {
    whatWentWell.push('This was a planned deload week — lower volume here is the intent.');
  }

  // --- Intensity distribution ---------------------------------------------
  if (args.intensityDistribution) {
    const distribution = args.intensityDistribution;
    if (distribution.easyShareBelowGuideline) {
      whatNeedsAttention.push(
        `Only ${Math.round(distribution.easyShare * 100)}% of your running time was genuinely easy. The common guideline is around 80%; running easy days too hard is the most frequent self-coaching error.`,
      );
    } else {
      whatWentWell.push(
        `${Math.round(distribution.easyShare * 100)}% of your running was easy — a healthy distribution.`,
      );
    }
  }

  // --- Recovery ------------------------------------------------------------
  if (averageRecoveryScore !== undefined) {
    if (averageRecoveryScore >= 70) {
      whatWentWell.push(`Recovery averaged ${Math.round(averageRecoveryScore)} across the week.`);
    } else if (averageRecoveryScore < 50) {
      whatNeedsAttention.push(
        `Recovery averaged ${Math.round(averageRecoveryScore)}, which is low. Sleep and easy-day discipline are the two biggest levers here.`,
      );
    }
  }

  if (averageSleepSeconds !== undefined && averageSleepSeconds < 6.5 * 3600) {
    whatNeedsAttention.push(
      `Sleep averaged ${formatHours(averageSleepSeconds)} per night. This is the single largest constraint on how much training you can absorb.`,
    );
  }

  // --- Efficiency ----------------------------------------------------------
  if (args.efficiencyTrend?.direction === 'improving' && args.efficiencyTrend.confidence !== 'low') {
    whatWentWell.push(
      `Your pace at a given heart rate improved ${args.efficiencyTrend.changePercent.toFixed(1)}%.`,
    );
  }

  const assessment = assessWeek({
    completionRate,
    distanceChangePercent,
    averageRecoveryScore,
    isDeloadWeek: args.isDeloadWeek ?? false,
  });

  return {
    weekKey: summary.weekKey,
    weekStart: summary.weekStart,
    summary,
    distanceChangePercent:
      distanceChangePercent !== undefined ? round(distanceChangePercent, 1) : undefined,
    completionRate: round(completionRate, 2),
    averageRecoveryScore:
      averageRecoveryScore !== undefined ? round(averageRecoveryScore, 0) : undefined,
    averageSleepSeconds:
      averageSleepSeconds !== undefined ? Math.round(averageSleepSeconds) : undefined,
    assessment,
    headline: ASSESSMENT_HEADLINES[assessment],
    whatWentWell,
    whatNeedsAttention,
    keyAdaptation: describeAdaptation(summary, args.efficiencyTrend),
    nextWeekPriority: nextPriority(assessment, whatNeedsAttention),
  };
}

const ASSESSMENT_HEADLINES: Record<WeeklyAssessment, string> = {
  excellent_progression: 'Excellent week',
  good_progression: 'Good progression',
  steady: 'Steady week',
  below_plan: 'Below plan',
  significantly_below_plan: 'Well below plan',
  overreaching: 'Pushing too hard',
};

function assessWeek(args: {
  completionRate: number;
  distanceChangePercent?: number;
  averageRecoveryScore?: number;
  isDeloadWeek: boolean;
}): WeeklyAssessment {
  const { completionRate, distanceChangePercent, averageRecoveryScore, isDeloadWeek } = args;

  // Big volume jump plus suppressed recovery is the overreaching pattern.
  if (
    !isDeloadWeek &&
    (distanceChangePercent ?? 0) > 25 &&
    (averageRecoveryScore ?? 100) < 50
  ) {
    return 'overreaching';
  }

  if (completionRate < 0.4) return 'significantly_below_plan';
  if (completionRate < 0.7) return 'below_plan';

  if (completionRate >= 0.9 && (averageRecoveryScore ?? 60) >= 65) {
    return (distanceChangePercent ?? 0) > 3 ? 'excellent_progression' : 'good_progression';
  }

  if (completionRate >= 0.85) return 'good_progression';
  return 'steady';
}

function describeAdaptation(summary: WeeklySummary, trend?: EfficiencyTrend): string {
  if (trend?.direction === 'improving' && trend.confidence !== 'low') {
    return 'Aerobic efficiency is improving — you are producing more speed for the same cardiovascular cost.';
  }
  if (summary.longestRunMeters >= 15000) {
    return 'Long-run durability is the main adaptation this week.';
  }
  if (summary.qualitySessions >= 2) {
    return 'Threshold and speed development were the primary stimulus this week.';
  }
  return 'Aerobic base development was the primary stimulus this week.';
}

function nextPriority(assessment: WeeklyAssessment, attention: readonly string[]): string {
  switch (assessment) {
    case 'overreaching':
      return 'Hold volume flat next week and keep every easy day genuinely easy.';
    case 'significantly_below_plan':
    case 'below_plan':
      return 'Prioritise getting the planned sessions done, even if each one is shorter than prescribed.';
    case 'excellent_progression':
      return 'Repeat this pattern. Resist the urge to add more on top of a week that already worked.';
    case 'good_progression':
      return attention.length > 0
        ? 'Keep the structure, and address the one item flagged above.'
        : 'Continue the current progression.';
    case 'steady':
      return 'Aim for one more completed session or slightly more easy volume next week.';
  }
}

function formatHours(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

// ---------------------------------------------------------------------------
// Block review
// ---------------------------------------------------------------------------

export interface BlockReview {
  blockId: string;
  blockName: string;
  blockType: TrainingBlock['type'];
  durationWeeks: number;
  totalDistanceMeters: number;
  volumeChangePercent?: number;
  easyPaceChangeSecondsPerKm?: number;
  thresholdPaceChangeSecondsPerKm?: number;
  longestRunStartMeters?: number;
  longestRunEndMeters?: number;
  averageRecoveryScore?: number;
  completionRate: number;
  assessment: string;
  recommendedNextBlock: TrainingBlock['type'];
  recommendationReason: string;
}

export function buildBlockReview(args: {
  block: TrainingBlock;
  weeklySummaries: readonly WeeklySummary[];
  recoveryStates: readonly RecoveryState[];
  /** Easy-pace samples at comparable HR, oldest first, seconds per km. */
  easyPaceSamples?: readonly number[];
  thresholdPaceStart?: number;
  thresholdPaceEnd?: number;
}): BlockReview {
  const { block, weeklySummaries, recoveryStates } = args;

  const totalDistance = sum(weeklySummaries.map((w) => w.completedDistanceMeters));
  const first = weeklySummaries[0];
  const last = weeklySummaries[weeklySummaries.length - 1];

  const volumeChangePercent =
    first && last && first.completedDistanceMeters > 0
      ? percentChange(first.completedDistanceMeters, last.completedDistanceMeters)
      : undefined;

  const totalPlanned = sum(weeklySummaries.map((w) => w.plannedSessions));
  const totalCompleted = sum(weeklySummaries.map((w) => w.completedSessions));
  const completionRate = totalPlanned > 0 ? totalCompleted / totalPlanned : 1;

  // Compare the first third of the block against the last third rather than
  // single sessions, which are too noisy to draw a conclusion from.
  let easyPaceChange: number | undefined;
  if (args.easyPaceSamples && args.easyPaceSamples.length >= 4) {
    const third = Math.max(1, Math.floor(args.easyPaceSamples.length / 3));
    const startMean = mean(args.easyPaceSamples.slice(0, third));
    const endMean = mean(args.easyPaceSamples.slice(-third));
    if (startMean !== undefined && endMean !== undefined) {
      easyPaceChange = round(endMean - startMean, 0);
    }
  }

  const thresholdPaceChange =
    args.thresholdPaceStart !== undefined && args.thresholdPaceEnd !== undefined
      ? round(args.thresholdPaceEnd - args.thresholdPaceStart, 0)
      : undefined;

  const averageRecoveryScore = mean(recoveryStates.map((r) => r.score));

  const next = recommendNextBlock(block.type, {
    completionRate,
    averageRecoveryScore,
    easyPaceChange,
  });

  return {
    blockId: block.id,
    blockName: block.name,
    blockType: block.type,
    durationWeeks: block.durationWeeks,
    totalDistanceMeters: Math.round(totalDistance),
    volumeChangePercent: volumeChangePercent !== undefined ? round(volumeChangePercent, 0) : undefined,
    easyPaceChangeSecondsPerKm: easyPaceChange,
    thresholdPaceChangeSecondsPerKm: thresholdPaceChange,
    longestRunStartMeters: first?.longestRunMeters,
    longestRunEndMeters: last?.longestRunMeters,
    averageRecoveryScore: averageRecoveryScore !== undefined ? round(averageRecoveryScore, 0) : undefined,
    completionRate: round(completionRate, 2),
    assessment: assessBlock(block, { easyPaceChange, volumeChangePercent, completionRate }),
    recommendedNextBlock: next.type,
    recommendationReason: next.reason,
  };
}

function assessBlock(
  block: TrainingBlock,
  args: {
    easyPaceChange?: number;
    volumeChangePercent?: number;
    completionRate: number;
  },
): string {
  const parts: string[] = [];

  // Negative pace change = faster at the same effort.
  if (args.easyPaceChange !== undefined && args.easyPaceChange < -5) {
    parts.push(
      `easy pace improved by ${Math.abs(args.easyPaceChange)} s/km at comparable effort`,
    );
  } else if (args.easyPaceChange !== undefined && args.easyPaceChange > 5) {
    parts.push(`easy pace slowed by ${args.easyPaceChange} s/km at comparable effort`);
  }

  if (args.volumeChangePercent !== undefined && args.volumeChangePercent > 5) {
    parts.push(`volume rose ${Math.round(args.volumeChangePercent)}%`);
  }

  if (args.completionRate < 0.7) {
    parts.push(`only ${Math.round(args.completionRate * 100)}% of sessions were completed`);
  }

  if (parts.length === 0) {
    return `${block.name} block completed. Not enough comparable data to characterise the adaptation precisely.`;
  }

  return `${block.name} block completed: ${parts.join(', ')}.`;
}

function recommendNextBlock(
  current: TrainingBlock['type'],
  signals: { completionRate: number; averageRecoveryScore?: number; easyPaceChange?: number },
): { type: TrainingBlock['type']; reason: string } {
  // A block the athlete couldn't complete, or finished depleted, argues for
  // consolidation rather than escalation.
  const struggled =
    signals.completionRate < 0.65 || (signals.averageRecoveryScore ?? 100) < 45;

  if (struggled) {
    return {
      type: 'recovery',
      reason:
        'Completion and recovery signals suggest consolidating before adding more stress. A short recovery block protects the progress already made.',
    };
  }

  switch (current) {
    case 'base':
      return {
        type: 'build',
        reason: 'Your aerobic base is established, so the next block can add threshold work.',
      };
    case 'build':
      return {
        type: 'specific',
        reason: 'Threshold work is in place; the next block should sharpen toward race pace.',
      };
    case 'specific':
      return { type: 'taper', reason: 'Specific fitness is built. Time to shed fatigue.' };
    case 'peak':
      return { type: 'taper', reason: 'Peak work is complete. Taper into the race.' };
    case 'taper':
      return { type: 'race', reason: 'You are tapered and ready to race.' };
    case 'race':
      return { type: 'recovery', reason: 'Recover properly before starting the next cycle.' };
    case 'recovery':
      return { type: 'base', reason: 'Recovery is complete. Rebuild the aerobic base.' };
  }
}

/** Group completed workouts into weekly buckets keyed by Monday. */
export function groupWorkoutsByWeek(
  workouts: readonly CanonicalWorkout[],
): Map<string, CanonicalWorkout[]> {
  const byWeek = new Map<string, CanonicalWorkout[]>();
  for (const workout of workouts) {
    const localDate = toLocalDate(workout.startTime, workout.timezone);
    const week = startOfWeek(localDate);
    const existing = byWeek.get(week) ?? [];
    existing.push(workout);
    byWeek.set(week, existing);
  }
  return byWeek;
}
