/**
 * Training state classification.
 *
 * Answers "where is this athlete right now?" by combining load trajectory,
 * recovery, consistency and performance trend. Explicitly NOT a medical
 * assessment: `overreaching_risk` describes a training pattern, not a
 * diagnosis of overtraining syndrome, and the copy throughout says so.
 *
 * No single signal decides the outcome. Each contributes a weighted vote, and
 * the classification reports which signals drove it so the athlete can see the
 * reasoning rather than a bare label.
 */

import type { Reason, TrainingState, TrainingStateAssessment } from '../domain/coaching.js';
import type { RecoveryState } from '../domain/recovery.js';
import type { TrainingLoadState } from './load.js';
import type { EfficiencyTrend } from './efficiency.js';
import { clamp, mean, round } from '../util/stats.js';

export interface TrainingStateInputs {
  loadState?: TrainingLoadState;
  /** Recent recovery states, oldest first. */
  recentRecovery: readonly RecoveryState[];
  efficiencyTrend?: EfficiencyTrend;
  /** Sessions completed vs planned over the trailing 4 weeks. */
  consistency?: { completed: number; planned: number };
  /** Weekly distance in metres for the trailing weeks, oldest first. */
  weeklyDistanceMeters: readonly number[];
  /** Days since the last completed run. */
  daysSinceLastRun?: number;
  /** True when the athlete has flagged active pain in a recent check-in. */
  activePainReported?: boolean;
  /** Consecutive days the athlete has reported low energy (<= 2/5). */
  consecutiveLowEnergyDays?: number;
}

export function assessTrainingState(inputs: TrainingStateInputs): TrainingStateAssessment {
  const signals: Reason[] = [];

  const recoveryScores = inputs.recentRecovery.map((r) => r.score);
  const recentRecoveryMean = mean(recoveryScores.slice(-7));
  const load = inputs.loadState;

  // --- Gather evidence -----------------------------------------------------

  // Volume trajectory: compare the most recent week against the prior 3.
  const weeks = inputs.weeklyDistanceMeters;
  let volumeTrendPercent: number | undefined;
  if (weeks.length >= 2) {
    const current = weeks[weeks.length - 1]!;
    const priorWeeks = weeks.slice(Math.max(0, weeks.length - 4), weeks.length - 1);
    const priorMean = mean(priorWeeks);
    if (priorMean !== undefined && priorMean > 0) {
      volumeTrendPercent = ((current - priorMean) / priorMean) * 100;
    }
  }

  if (volumeTrendPercent !== undefined) {
    if (volumeTrendPercent > 25) {
      signals.push({
        key: 'volume_spike',
        message: `Weekly distance is ${Math.round(volumeTrendPercent)}% above your recent average`,
        severity: 'warning',
        weight: -2,
        detail: 'Rapid volume increases are the most common precursor to running injuries.',
      });
    } else if (volumeTrendPercent > 8) {
      signals.push({
        key: 'volume_building',
        message: `Weekly distance is up ${Math.round(volumeTrendPercent)}% on your recent average`,
        severity: 'info',
        weight: 1,
      });
    } else if (volumeTrendPercent < -30) {
      signals.push({
        key: 'volume_drop',
        message: `Weekly distance is down ${Math.round(Math.abs(volumeTrendPercent))}%`,
        severity: 'caution',
        weight: -0.5,
      });
    }
  }

  if (load?.acuteChronicRatio !== undefined) {
    const ratio = load.acuteChronicRatio;
    if (ratio > 1.5) {
      signals.push({
        key: 'acwr_high',
        message: 'Recent training load is well above what your recent training supports',
        severity: 'warning',
        weight: -2,
        detail: `Acute:chronic load ratio ${ratio.toFixed(2)}.`,
      });
    } else if (ratio > 1.25) {
      signals.push({
        key: 'acwr_building',
        message: 'Training load is climbing faster than your established base',
        severity: 'caution',
        weight: -0.5,
        detail: `Acute:chronic load ratio ${ratio.toFixed(2)}.`,
      });
    } else if (ratio < 0.75) {
      signals.push({
        key: 'acwr_low',
        message: 'Recent training load is well below your established base',
        severity: 'info',
        weight: 0.5,
        detail: `Acute:chronic load ratio ${ratio.toFixed(2)}.`,
      });
    }
  }

  if (load?.monotony !== undefined && load.monotony > 2 && load.weeklyLoad > 0) {
    signals.push({
      key: 'monotony_high',
      message: 'Your training is very uniform — little contrast between hard and easy days',
      severity: 'caution',
      weight: -1,
      detail: `Monotony ${load.monotony.toFixed(2)}. Adaptation generally improves with clearer hard/easy separation.`,
    });
  }

  if (recentRecoveryMean !== undefined) {
    if (recentRecoveryMean < 40) {
      signals.push({
        key: 'recovery_low',
        message: `Recovery has averaged ${Math.round(recentRecoveryMean)} over the last week`,
        severity: 'warning',
        weight: -2,
      });
    } else if (recentRecoveryMean < 55) {
      signals.push({
        key: 'recovery_moderate',
        message: `Recovery has averaged ${Math.round(recentRecoveryMean)} over the last week`,
        severity: 'caution',
        weight: -1,
      });
    } else if (recentRecoveryMean > 72) {
      signals.push({
        key: 'recovery_good',
        message: `Recovery has averaged ${Math.round(recentRecoveryMean)} over the last week`,
        severity: 'info',
        weight: 1.5,
      });
    }
  }

  if (inputs.efficiencyTrend) {
    const trend = inputs.efficiencyTrend;
    if (trend.direction === 'improving' && trend.confidence !== 'low') {
      signals.push({
        key: 'efficiency_improving',
        message: `Pace at a given heart rate has improved ${trend.changePercent.toFixed(1)}%`,
        severity: 'info',
        weight: 1.5,
      });
    } else if (trend.direction === 'declining' && trend.confidence !== 'low') {
      signals.push({
        key: 'efficiency_declining',
        message: `Pace at a given heart rate has slipped ${Math.abs(trend.changePercent).toFixed(1)}%`,
        severity: 'caution',
        weight: -1.5,
      });
    }
  }

  let consistencyRate: number | undefined;
  if (inputs.consistency && inputs.consistency.planned > 0) {
    consistencyRate = inputs.consistency.completed / inputs.consistency.planned;
    if (consistencyRate < 0.5) {
      signals.push({
        key: 'consistency_low',
        message: `You have completed ${inputs.consistency.completed} of ${inputs.consistency.planned} planned sessions`,
        severity: 'caution',
        weight: -1,
      });
    } else if (consistencyRate >= 0.85) {
      signals.push({
        key: 'consistency_high',
        message: `You have completed ${inputs.consistency.completed} of ${inputs.consistency.planned} planned sessions`,
        severity: 'info',
        weight: 1,
      });
    }
  }

  if (inputs.daysSinceLastRun !== undefined && inputs.daysSinceLastRun >= 10) {
    signals.push({
      key: 'long_layoff',
      message: `It has been ${inputs.daysSinceLastRun} days since your last run`,
      severity: 'caution',
      weight: -1,
    });
  }

  if (inputs.consecutiveLowEnergyDays !== undefined && inputs.consecutiveLowEnergyDays >= 3) {
    signals.push({
      key: 'sustained_low_energy',
      message: `You have reported low energy ${inputs.consecutiveLowEnergyDays} days running`,
      severity: 'warning',
      weight: -2,
    });
  }

  if (inputs.activePainReported) {
    signals.push({
      key: 'active_pain',
      message: 'You have reported pain',
      severity: 'warning',
      weight: -2,
      detail: 'Training recommendations are being kept conservative while this is flagged.',
    });
  }

  // --- Classify ------------------------------------------------------------
  const state = classify({
    signals,
    recentRecoveryMean,
    load,
    volumeTrendPercent,
    consistencyRate,
    daysSinceLastRun: inputs.daysSinceLastRun,
    weeklyDistanceMeters: weeks,
  });

  // Confidence rises with how much evidence we actually have.
  const evidenceCount = signals.length + (load ? 1 : 0) + (recentRecoveryMean !== undefined ? 1 : 0);
  const confidence = clamp(0.3 + evidenceCount * 0.1, 0.3, 0.95);

  // Referral prompt for sustained extreme fatigue or persistent pain. This is
  // a signpost, never a diagnosis.
  const recommendProfessionalReview =
    Boolean(inputs.activePainReported) ||
    (inputs.consecutiveLowEnergyDays ?? 0) >= 5 ||
    (recentRecoveryMean !== undefined && recentRecoveryMean < 30 && signals.some((s) => s.key === 'sustained_low_energy'));

  return {
    state,
    confidence: round(confidence, 2),
    signals: signals.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)),
    summary: summarize(state, signals, recommendProfessionalReview),
    recommendProfessionalReview,
  };
}

function classify(context: {
  signals: readonly Reason[];
  recentRecoveryMean?: number;
  load?: TrainingLoadState;
  volumeTrendPercent?: number;
  consistencyRate?: number;
  daysSinceLastRun?: number;
  weeklyDistanceMeters: readonly number[];
}): TrainingState {
  const {
    signals,
    recentRecoveryMean,
    load,
    volumeTrendPercent,
    daysSinceLastRun,
    weeklyDistanceMeters,
  } = context;

  const netScore = signals.reduce((acc, s) => acc + s.weight, 0);
  const hasWarning = (key: string): boolean =>
    signals.some((s) => s.key === key && s.severity === 'warning');

  // Overreaching risk: high load AND suppressed recovery together. Either one
  // alone is normal training; the combination is the pattern worth flagging.
  const loadIsHigh = (load?.acuteChronicRatio ?? 0) > 1.4 || hasWarning('volume_spike');
  const recoveryIsPoor = (recentRecoveryMean ?? 100) < 45;
  if (loadIsHigh && recoveryIsPoor) return 'overreaching_risk';
  if (hasWarning('sustained_low_energy') && recoveryIsPoor) return 'overreaching_risk';

  // Undertrained: little or no recent running.
  const recentVolume = weeklyDistanceMeters[weeklyDistanceMeters.length - 1] ?? 0;
  if ((daysSinceLastRun ?? 0) >= 14 || (weeklyDistanceMeters.length >= 2 && recentVolume < 5000)) {
    return 'undertrained';
  }

  if (recentRecoveryMean !== undefined) {
    if (recentRecoveryMean < 38) return 'highly_fatigued';
    if (recentRecoveryMean < 52 && netScore < 0) return 'fatigued';
  }

  if (netScore <= -3) return 'highly_fatigued';
  if (netScore <= -1.5) return 'fatigued';

  // Building: volume/load climbing while recovery holds up.
  const isBuilding =
    (volumeTrendPercent !== undefined && volumeTrendPercent > 8) ||
    (load?.acuteChronicRatio !== undefined && load.acuteChronicRatio > 1.1);
  if (isBuilding && netScore >= 0) return 'building';

  // Fresh: low acute load and good recovery — typically a taper or post-rest.
  const isFresh =
    (load?.acuteChronicRatio !== undefined && load.acuteChronicRatio < 0.85) &&
    (recentRecoveryMean ?? 0) > 65;
  if (isFresh) return 'fresh';

  return 'normal';
}

const STATE_SUMMARIES: Record<TrainingState, string> = {
  fresh: 'You are carrying little fatigue and recovering well. A good window for a hard session or a race.',
  normal: 'Your training and recovery are in balance. Keep doing what you are doing.',
  building: 'You are absorbing an increasing training load and recovering adequately. This is productive training.',
  fatigued: 'Fatigue is accumulating faster than you are clearing it. Not alarming, but worth respecting on hard days.',
  highly_fatigued:
    'You are carrying substantial fatigue. Reducing intensity for a few days usually restores progress faster than pushing through.',
  undertrained: 'Your recent running volume is low. The priority is rebuilding consistency before adding intensity.',
  overreaching_risk:
    'Your training load is high while your recovery signals are suppressed. This combination is worth interrupting with easier days.',
};

function summarize(
  state: TrainingState,
  signals: readonly Reason[],
  recommendProfessionalReview: boolean,
): string {
  const base = STATE_SUMMARIES[state];
  const top = signals.filter((s) => s.severity === 'warning').slice(0, 2);
  const detail = top.length > 0 ? ` Key signals: ${top.map((s) => s.message.toLowerCase()).join('; ')}.` : '';
  const referral = recommendProfessionalReview
    ? ' If this persists or you have pain, it is worth discussing with a qualified health professional.'
    : '';
  return `${base}${detail}${referral}`;
}
