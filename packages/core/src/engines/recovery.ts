/**
 * Composite recovery engine.
 *
 * Design position: this deliberately does NOT mirror WHOOP's recovery score.
 * A provider score is one opinion, computed from that provider's sensors and
 * its own model, and it knows nothing about the athlete's training plan. Our
 * job is to combine it with everything else we know — sleep, HRV and RHR
 * relative to the athlete's OWN baseline, recent training load, and how the
 * athlete says they feel — into a single interpretation that the coaching
 * engine can act on.
 *
 * Two principles govern the maths:
 *
 * 1. No single signal dominates. Weights are redistributed across whatever
 *    signals are present, so a missing WHOOP strap degrades the score's
 *    confidence rather than its value.
 *
 * 2. Deviation from personal baseline beats absolute values. An HRV of 45 ms
 *    is meaningless in isolation; 45 ms against a 14-day baseline of 62 ms is
 *    a signal. All physiological components are scored against the athlete's
 *    own rolling baseline for this reason.
 */

import type {
  RecoveryComponent,
  RecoveryComponentKey,
  RecoveryRecord,
  RecoveryState,
  SignalBaseline,
  SleepRecord,
  SubjectiveCheckIn,
  RecoveryBand,
} from '../domain/recovery.js';
import type { TrainingLoadState } from './load.js';
import { clamp, mean, round, scaleClamped, stdDev } from '../util/stats.js';

/** Intended weights when every signal is present; renormalised when some are missing. */
const COMPONENT_WEIGHTS: Record<RecoveryComponentKey, number> = {
  provider_recovery: 0.22,
  hrv: 0.2,
  resting_hr: 0.15,
  sleep_duration: 0.15,
  sleep_quality: 0.08,
  subjective: 0.12,
  training_load: 0.08,
};

const COMPONENT_LABELS: Record<RecoveryComponentKey, string> = {
  provider_recovery: 'Device recovery',
  hrv: 'Heart rate variability',
  resting_hr: 'Resting heart rate',
  sleep_duration: 'Sleep duration',
  sleep_quality: 'Sleep quality',
  subjective: 'How you feel',
  training_load: 'Recent training load',
};

/**
 * Build a rolling baseline for a signal, excluding the current day so today's
 * value is compared against history rather than against itself.
 */
export function buildBaseline(
  values: readonly number[],
  windowDays: number,
): SignalBaseline | undefined {
  const window = values.slice(-windowDays);
  if (window.length < 3) return undefined;
  const m = mean(window);
  const sd = stdDev(window);
  if (m === undefined || sd === undefined) return undefined;
  return { mean: m, stdDev: sd, sampleCount: window.length, windowDays };
}

export interface RecoveryInputs {
  athleteId: string;
  date: string;
  today?: RecoveryRecord;
  lastNightSleep?: SleepRecord;
  checkIn?: SubjectiveCheckIn;
  loadState?: TrainingLoadState;
  /** Historical HRV values (oldest first), excluding today. */
  hrvHistory?: readonly number[];
  /** Historical resting HR values (oldest first), excluding today. */
  restingHrHistory?: readonly number[];
  /** Historical nightly sleep durations in seconds, excluding last night. */
  sleepHistorySeconds?: readonly number[];
  /** Athlete's personal sleep need in seconds. Defaults to 8 h. */
  sleepNeedSeconds?: number;
}

/**
 * Score today's recovery, 0-100.
 */
export function computeRecoveryState(inputs: RecoveryInputs): RecoveryState {
  const components: RecoveryComponent[] = [];
  const missing: string[] = [];

  // --- Provider recovery score --------------------------------------------
  if (inputs.today?.providerRecoveryScore !== undefined && !inputs.today.calibrating) {
    components.push({
      key: 'provider_recovery',
      label: COMPONENT_LABELS.provider_recovery,
      score: clamp(inputs.today.providerRecoveryScore, 0, 100),
      weight: COMPONENT_WEIGHTS.provider_recovery,
      detail: `${Math.round(inputs.today.providerRecoveryScore)}% from ${inputs.today.source}`,
    });
  } else if (inputs.today?.calibrating) {
    missing.push('Device recovery score (still calibrating)');
  } else {
    missing.push('Device recovery score');
  }

  // --- HRV vs personal baseline -------------------------------------------
  const hrvBaseline = inputs.hrvHistory ? buildBaseline(inputs.hrvHistory, 14) : undefined;
  if (inputs.today?.hrvRmssdMs !== undefined && hrvBaseline && hrvBaseline.mean > 0) {
    const deltaPercent = ((inputs.today.hrvRmssdMs - hrvBaseline.mean) / hrvBaseline.mean) * 100;
    // −20% maps to 0, +10% maps to 100. Suppressed HRV matters much more than
    // elevated HRV helps, so the scale is deliberately asymmetric.
    const score = scaleClamped(deltaPercent, -20, 10, 0, 100);
    components.push({
      key: 'hrv',
      label: COMPONENT_LABELS.hrv,
      score,
      weight: COMPONENT_WEIGHTS.hrv,
      detail: `${Math.round(inputs.today.hrvRmssdMs)} ms, ${formatDelta(deltaPercent)}% vs ${hrvBaseline.windowDays}-day baseline`,
    });
  } else {
    missing.push(inputs.today?.hrvRmssdMs === undefined ? 'HRV' : 'HRV baseline (needs 3+ days)');
  }

  // --- Resting HR vs personal baseline ------------------------------------
  const rhrBaseline = inputs.restingHrHistory ? buildBaseline(inputs.restingHrHistory, 14) : undefined;
  if (inputs.today?.restingHeartRateBpm !== undefined && rhrBaseline && rhrBaseline.mean > 0) {
    const delta = inputs.today.restingHeartRateBpm - rhrBaseline.mean;
    // +8 bpm above baseline maps to 0; −3 bpm maps to 100.
    const score = scaleClamped(delta, 8, -3, 0, 100);
    components.push({
      key: 'resting_hr',
      label: COMPONENT_LABELS.resting_hr,
      score,
      weight: COMPONENT_WEIGHTS.resting_hr,
      detail: `${Math.round(inputs.today.restingHeartRateBpm)} bpm, ${formatDelta(delta)} bpm vs baseline`,
    });
  } else {
    missing.push('Resting heart rate baseline');
  }

  // --- Sleep duration ------------------------------------------------------
  const sleepNeed = inputs.sleepNeedSeconds ?? 8 * 3600;
  if (inputs.lastNightSleep) {
    const slept = inputs.lastNightSleep.totalSleepSeconds;
    // 60% of need maps to 0, 100% of need maps to 100.
    const score = scaleClamped(slept / sleepNeed, 0.6, 1.0, 0, 100);
    components.push({
      key: 'sleep_duration',
      label: COMPONENT_LABELS.sleep_duration,
      score,
      weight: COMPONENT_WEIGHTS.sleep_duration,
      detail: `${formatHours(slept)} vs ${formatHours(sleepNeed)} target`,
    });

    // --- Sleep quality ----------------------------------------------------
    const quality =
      inputs.lastNightSleep.performancePercent ??
      (inputs.lastNightSleep.efficiencyPercent !== undefined
        ? inputs.lastNightSleep.efficiencyPercent
        : undefined);
    if (quality !== undefined) {
      components.push({
        key: 'sleep_quality',
        label: COMPONENT_LABELS.sleep_quality,
        score: clamp(quality, 0, 100),
        weight: COMPONENT_WEIGHTS.sleep_quality,
        detail: `${Math.round(quality)}% sleep performance`,
      });
    } else {
      missing.push('Sleep quality');
    }
  } else {
    missing.push('Last night’s sleep');
  }

  // --- Subjective check-in -------------------------------------------------
  if (inputs.checkIn) {
    const { energy, soreness, stress, motivation } = inputs.checkIn;
    // All four are stored "higher is better" on a 1-5 scale.
    // Energy and soreness dominate; motivation is the weakest physiological
    // signal but a useful early indicator of accumulated fatigue.
    const weighted = energy * 0.35 + soreness * 0.3 + stress * 0.2 + motivation * 0.15;
    const score = scaleClamped(weighted, 1, 5, 0, 100);
    components.push({
      key: 'subjective',
      label: COMPONENT_LABELS.subjective,
      score,
      weight: COMPONENT_WEIGHTS.subjective,
      detail: `Energy ${energy}/5, soreness ${soreness}/5, stress ${stress}/5`,
    });
  } else {
    missing.push('Morning check-in');
  }

  // --- Recent training load ------------------------------------------------
  if (inputs.loadState?.acuteChronicRatio !== undefined) {
    const ratio = inputs.loadState.acuteChronicRatio;
    // A ratio near 1.0 is neutral (score 70). Well above 1.0 means acute work
    // is outrunning the chronic base, which is a recovery cost.
    const score =
      ratio <= 1
        ? scaleClamped(ratio, 0.6, 1.0, 100, 70)
        : scaleClamped(ratio, 1.0, 1.6, 70, 10);
    components.push({
      key: 'training_load',
      label: COMPONENT_LABELS.training_load,
      score,
      weight: COMPONENT_WEIGHTS.training_load,
      detail: `Acute:chronic load ratio ${ratio.toFixed(2)}`,
    });
  } else {
    missing.push('Training load ratio (needs 3+ weeks of history)');
  }

  // --- Combine -------------------------------------------------------------
  if (components.length === 0) {
    return {
      athleteId: inputs.athleteId,
      date: inputs.date,
      score: 50,
      band: 'yellow',
      components: [],
      missingSignals: missing,
      dataCompleteness: 0,
      summary:
        'No recovery data available yet. Connect a wearable or complete the morning check-in to get a readiness assessment.',
    };
  }

  // Renormalise across present signals only.
  const totalWeight = components.reduce((acc, c) => acc + c.weight, 0);
  const score = components.reduce((acc, c) => acc + c.score * c.weight, 0) / totalWeight;

  const intendedWeight = Object.values(COMPONENT_WEIGHTS).reduce((a, b) => a + b, 0);
  const dataCompleteness = clamp(totalWeight / intendedWeight, 0, 1);

  const band = bandFor(score);

  return {
    athleteId: inputs.athleteId,
    date: inputs.date,
    score: round(score, 0),
    band,
    components: components.sort((a, b) => b.weight - a.weight),
    missingSignals: missing,
    dataCompleteness: round(dataCompleteness, 2),
    summary: summarize(score, band, components, dataCompleteness),
  };
}

function bandFor(score: number): RecoveryBand {
  if (score >= 67) return 'green';
  if (score >= 40) return 'yellow';
  return 'red';
}

function formatDelta(value: number): string {
  const rounded = round(value, 1);
  return rounded >= 0 ? `+${rounded}` : `${rounded}`;
}

function formatHours(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

/**
 * Build the athlete-facing summary, naming the strongest limiter so the
 * sentence carries information rather than just restating the number.
 */
function summarize(
  score: number,
  band: RecoveryBand,
  components: readonly RecoveryComponent[],
  completeness: number,
): string {
  const weakest = [...components].sort((a, b) => a.score - b.score)[0];
  const strongest = [...components].sort((a, b) => b.score - a.score)[0];

  const coverage =
    completeness < 0.5
      ? ' This is based on limited data, so treat it as a rough signal.'
      : '';

  switch (band) {
    case 'green':
      return `Recovery is good (${Math.round(score)}). ${
        strongest ? `${strongest.label} is your strongest signal today.` : ''
      } You are in shape to train as planned.${coverage}`;
    case 'yellow':
      return `Recovery is moderate (${Math.round(score)}).${
        weakest ? ` ${weakest.label} is the main limiter — ${weakest.detail}.` : ''
      } Training is fine, but keep intensity controlled.${coverage}`;
    case 'red':
      return `Recovery is low (${Math.round(score)}).${
        weakest ? ` ${weakest.label} stands out — ${weakest.detail}.` : ''
      } Prioritise easy work or rest today.${coverage}`;
  }
}

/**
 * Estimate the athlete's personal sleep need from their own history.
 *
 * Uses the 75th percentile of recent nights rather than the mean, on the
 * reasoning that most people are somewhat sleep-restricted on a typical night,
 * so the mean understates need. Falls back to 8 hours without enough history.
 */
export function estimateSleepNeed(sleepHistorySeconds: readonly number[]): number {
  if (sleepHistorySeconds.length < 7) return 8 * 3600;
  const sorted = [...sleepHistorySeconds].sort((a, b) => a - b);
  const index = Math.floor(sorted.length * 0.75);
  return clamp(sorted[index] ?? 8 * 3600, 6 * 3600, 10 * 3600);
}
