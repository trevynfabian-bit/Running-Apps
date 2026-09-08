/**
 * Race goals and readiness.
 */

import type { ConfidenceLevel } from './provenance.js';

export const STANDARD_RACE_DISTANCES = {
  '1k': 1000,
  '3k': 3000,
  '5k': 5000,
  '10k': 10000,
  '15k': 15000,
  half_marathon: 21097.5,
  marathon: 42195,
} as const;

export type StandardRaceDistance = keyof typeof STANDARD_RACE_DISTANCES;

export interface RaceGoal {
  id: string;
  athleteId: string;
  name: string;
  /** Local date `YYYY-MM-DD`. */
  date: string;
  distanceMeters: number;
  /** Target finish time in seconds. Optional — a goal can be "just finish". */
  targetDurationSeconds?: number;
  priority: 'A' | 'B' | 'C';
  status: 'upcoming' | 'completed' | 'cancelled';
  notes?: string;
  /** Actual result, once raced. */
  resultDurationSeconds?: number;
  createdAt: Date;
}

/** A performance prediction for a distance, with its provenance. */
export interface RacePrediction {
  distanceMeters: number;
  predictedDurationSeconds: number;
  /** Implied average pace, seconds per km. */
  predictedPaceSecondsPerKm: number;
  confidence: ConfidenceLevel;
  /** Which model produced this, so the UI can explain it. */
  method: PredictionMethod;
  /** Human-readable basis, e.g. "from 5K time trial on 2026-07-14". */
  basis: string;
}

export type PredictionMethod = 'riegel' | 'vdot' | 'threshold_pace' | 'recent_race' | 'blended';

/** Race-day readiness assessment. */
export interface RaceReadiness {
  raceGoalId: string;
  /** 0-100. */
  score: number;
  weeksRemaining: number;
  targetDurationSeconds?: number;
  currentEstimateDurationSeconds?: number;
  /** Positive = currently slower than target. */
  gapSeconds?: number;
  confidence: ConfidenceLevel;
  factors: ReadinessFactor[];
  summary: string;
}

export interface ReadinessFactor {
  key: 'fitness_gap' | 'volume' | 'long_run' | 'consistency' | 'specificity' | 'time_remaining';
  label: string;
  /** 0-100 contribution score. */
  score: number;
  weight: number;
  detail: string;
}
