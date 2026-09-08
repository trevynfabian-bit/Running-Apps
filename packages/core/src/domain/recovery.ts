/**
 * Recovery, sleep and subjective-state domain types.
 */

export type RecoveryBand = 'green' | 'yellow' | 'red';

/** Normalised nightly sleep record, provider-agnostic. */
export interface SleepRecord {
  id: string;
  athleteId: string;
  /** Local date the sleep is attributed to (the morning it ended). */
  date: string;
  start: Date;
  end: Date;
  totalSleepSeconds: number;
  timeInBedSeconds?: number;
  lightSleepSeconds?: number;
  deepSleepSeconds?: number;
  remSleepSeconds?: number;
  awakeSeconds?: number;
  /** Provider's own 0-100 sleep performance score, when available. */
  performancePercent?: number;
  consistencyPercent?: number;
  efficiencyPercent?: number;
  respiratoryRate?: number;
  disturbanceCount?: number;
  isNap: boolean;
  source: string;
}

/** Normalised daily recovery/physiology record. */
export interface RecoveryRecord {
  id: string;
  athleteId: string;
  date: string;
  /** Provider's own recovery score, 0-100 (e.g. WHOOP recovery). */
  providerRecoveryScore?: number;
  hrvRmssdMs?: number;
  restingHeartRateBpm?: number;
  spo2Percent?: number;
  skinTempCelsius?: number;
  /** True while the provider is still establishing a personal baseline. */
  calibrating?: boolean;
  source: string;
}

/** The 10-second morning check-in. All scales are 1 (worst) to 5 (best). */
export interface SubjectiveCheckIn {
  id: string;
  athleteId: string;
  date: string;
  energy: number;
  /** 1 = extremely sore, 5 = no soreness. Kept in "higher is better" form. */
  soreness: number;
  /** 1 = very stressed, 5 = calm. */
  stress: number;
  motivation: number;
  hasPain: boolean;
  painNote?: string;
  createdAt: Date;
}

/**
 * The system's own composite recovery interpretation.
 * Deliberately distinct from any single provider's score.
 */
export interface RecoveryState {
  athleteId: string;
  date: string;
  /** 0-100 composite. */
  score: number;
  band: RecoveryBand;
  /** Named contributions, each already scaled 0-100, with its weight. */
  components: RecoveryComponent[];
  /** Signals that were unavailable, so the UI can be honest about coverage. */
  missingSignals: string[];
  /** 0..1 — how much of the intended signal set was actually present. */
  dataCompleteness: number;
  summary: string;
}

export interface RecoveryComponent {
  key: RecoveryComponentKey;
  label: string;
  /** Normalised 0-100 where 100 is "fully recovered on this axis". */
  score: number;
  weight: number;
  /** Raw value with units, for the detail view. */
  detail: string;
}

export type RecoveryComponentKey =
  | 'provider_recovery'
  | 'hrv'
  | 'resting_hr'
  | 'sleep_duration'
  | 'sleep_quality'
  | 'subjective'
  | 'training_load';

/** Rolling baseline for a physiological signal, used to judge deviations. */
export interface SignalBaseline {
  /** Mean over the baseline window. */
  mean: number;
  stdDev: number;
  sampleCount: number;
  windowDays: number;
}
