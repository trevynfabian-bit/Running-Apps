/**
 * Coaching decisions and their justifications.
 *
 * Every decision the system makes about an athlete's training is expressed as
 * a `CoachDecision` carrying explicit, human-readable reasons. Nothing that
 * changes a workout is allowed to be inexplicable.
 */

import type { PlannedWorkout } from './workout.js';

export const DECISION_TYPES = [
  'RUN_AS_PLANNED',
  'REDUCE_VOLUME',
  'REDUCE_INTENSITY',
  'CHANGE_TO_EASY_RUN',
  'CHANGE_TO_RECOVERY_RUN',
  'MOVE_WORKOUT',
  'REST',
  'CROSS_TRAIN',
  'KEEP_LONG_RUN',
  'SHORTEN_LONG_RUN',
  'DELOAD',
  'PROGRESS',
] as const;

export type DecisionType = (typeof DECISION_TYPES)[number];

/** Severity of a contributing signal, used to rank reasons for display. */
export type ReasonSeverity = 'info' | 'caution' | 'warning';

export interface Reason {
  /** Stable key so the UI and tests can assert on specific signals. */
  key: string;
  /** Athlete-facing sentence, e.g. "HRV is 9% below your 14-day baseline". */
  message: string;
  severity: ReasonSeverity;
  /** Signed contribution to the decision score; negative pushes toward rest. */
  weight: number;
  /** The underlying numbers, for the detail view. */
  detail?: string;
}

export interface CoachDecision {
  id: string;
  athleteId: string;
  /** Local date the decision applies to. */
  date: string;
  decision: DecisionType;
  /** 0..1 — how strongly the evidence supports this decision. */
  confidence: number;
  reasons: Reason[];
  affectedWorkoutId?: string;
  previousPlan?: PlannedWorkout;
  recommendedPlan?: PlannedWorkout;
  /** Short athlete-facing headline, e.g. "Intervals replaced with easy run". */
  headline: string;
  /** The "Why?" body text, assembled deterministically from `reasons`. */
  explanation: string;
  createdAt: Date;
}

/** Aggregate training state, derived from load, recovery and performance. */
export const TRAINING_STATES = [
  'fresh',
  'normal',
  'building',
  'fatigued',
  'highly_fatigued',
  'undertrained',
  'overreaching_risk',
] as const;

export type TrainingState = (typeof TRAINING_STATES)[number];

export interface TrainingStateAssessment {
  state: TrainingState;
  /** 0..1 confidence in the classification. */
  confidence: number;
  signals: Reason[];
  summary: string;
  /**
   * Set when the assessment should be paired with a recommendation to seek
   * professional advice (persistent pain, sustained extreme fatigue).
   * The system never diagnoses; this only prompts a referral message.
   */
  recommendProfessionalReview: boolean;
}

/** A generated insight surfaced on the dashboard or in review screens. */
export interface CoachInsight {
  id: string;
  athleteId: string;
  createdAt: Date;
  category: 'fitness' | 'recovery' | 'training_load' | 'consistency' | 'race' | 'technique';
  title: string;
  body: string;
  /** Facts the insight was computed from, so it can be audited. */
  dataPoints: string[];
  severity: ReasonSeverity;
}

/**
 * Epistemic status of a statement the coach makes.
 * The AI layer must tag every claim, so the athlete can tell a measurement
 * from an inference.
 */
export type ClaimKind = 'fact' | 'derived' | 'estimate' | 'interpretation' | 'recommendation';
