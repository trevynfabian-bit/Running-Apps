/**
 * Athlete profile: the stable facts, preferences and constraints the coaching
 * engine reasons about.
 */

import type { Sourced } from './provenance.js';

export type BiologicalSex = 'male' | 'female' | 'unspecified';

export type RunningExperience = 'beginner' | 'returning' | 'recreational' | 'experienced' | 'competitive';

export type SurfacePreference = 'road' | 'trail' | 'track' | 'treadmill' | 'mixed';

/** 0 = Sunday .. 6 = Saturday, matching `Date.getUTCDay`. */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface TrainingAvailability {
  /** Days the athlete is willing to run. */
  runDays: DayOfWeek[];
  /** Preferred day for the week's long run. */
  longRunDay: DayOfWeek;
  /** Hard rest days the planner must never schedule a run on. */
  restDays: DayOfWeek[];
  /** Days earmarked for gym work; the planner avoids stacking hard runs here. */
  strengthDays: DayOfWeek[];
  crossTrainingDays: DayOfWeek[];
  maxSessionsPerWeek: number;
  /** Typical minutes available on a weekday session. */
  typicalWeekdayMinutes?: number;
  /** Typical minutes available for the long run. */
  typicalLongRunMinutes?: number;
  preferredTimeOfDay?: 'early_morning' | 'morning' | 'midday' | 'evening';
}

export interface AthleteConstraints {
  /**
   * Free-text injury/pain notes from the athlete.
   * These are flags for the coach engine to be conservative — they are never
   * interpreted as a diagnosis.
   */
  injuryNotes?: string;
  /** True while the athlete reports active pain; forces conservative planning. */
  activePain: boolean;
  hasTreadmillAccess: boolean;
  hasTrackAccess: boolean;
  hasGymAccess: boolean;
  surfacePreference: SurfacePreference;
  /** Local dates (`YYYY-MM-DD`) the athlete cannot train. */
  unavailableDates: string[];
}

export interface RunningBackground {
  experience: RunningExperience;
  /** Self-reported weekly volume at intake, in metres. */
  typicalWeeklyDistanceMeters?: number;
  typicalSessionsPerWeek?: number;
  longestRecentRunMeters?: number;
  /** Self-reported comfortable easy pace, seconds per km. */
  selfReportedEasyPaceSecondsPerKm?: number;
  /** Years of consistent running. */
  yearsRunning?: number;
}

/** A race result the athlete reports or that we detect from their history. */
export interface RaceResult {
  id: string;
  distanceMeters: number;
  durationSeconds: number;
  /** Local date `YYYY-MM-DD`. */
  date: string;
  source: 'self_reported' | 'detected' | 'time_trial';
  name?: string;
}

export type ZoneMethodology =
  | 'max_hr_percent'
  | 'hr_reserve'
  | 'threshold_hr'
  | 'pace_threshold'
  | 'pace_vdot';

export interface AthletePreferences {
  units: 'metric' | 'imperial';
  /** Which zone system the UI and prescriptions use. Never silently mixed. */
  primaryZoneMethodology: ZoneMethodology;
  /** IANA timezone, e.g. `Asia/Jakarta`. */
  timezone: string;
  notifications: {
    dailyWorkout: boolean;
    morningCheckIn: boolean;
    weeklyReview: boolean;
    planAdjustments: boolean;
    syncFailures: boolean;
  };
}

export interface PhysiologicalMarkers {
  /** Measured or estimated max HR. Estimated when no maximal effort exists. */
  maxHeartRateBpm?: Sourced<number>;
  restingHeartRateBpm?: Sourced<number>;
  /** Lactate-threshold heart rate, estimated from threshold efforts. */
  thresholdHeartRateBpm?: number;
  /** Lactate-threshold pace in seconds per km. */
  thresholdPaceSecondsPerKm?: number;
  heightMeters?: Sourced<number>;
  weightKilograms?: Sourced<number>;
}

export interface AthleteProfile {
  id: string;
  userId: string;
  displayName: string;
  /** `YYYY-MM-DD`. Used for HR estimation and age-graded comparisons only. */
  dateOfBirth?: string;
  sex: BiologicalSex;

  background: RunningBackground;
  availability: TrainingAvailability;
  constraints: AthleteConstraints;
  preferences: AthletePreferences;
  markers: PhysiologicalMarkers;

  raceResults: RaceResult[];

  createdAt: Date;
  updatedAt: Date;
}

/** Whole years between a birth date and a reference instant. */
export function ageInYears(dateOfBirth: string, at: Date = new Date()): number | undefined {
  const parts = dateOfBirth.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return undefined;
  const [y, m, d] = parts as [number, number, number];
  let age = at.getUTCFullYear() - y;
  const hadBirthday =
    at.getUTCMonth() + 1 > m || (at.getUTCMonth() + 1 === m && at.getUTCDate() >= d);
  if (!hadBirthday) age -= 1;
  return age >= 0 && age < 130 ? age : undefined;
}

/**
 * Age-predicted maximum heart rate (Tanaka et al., 2001): 208 − 0.7 × age.
 *
 * Tanaka is used in preference to the older `220 − age` because it has a
 * markedly lower standard error across adult ages. It is still a *population*
 * estimate with roughly ±10 bpm individual spread, so it is only a fallback
 * when no observed maximal effort exists, and it is always labelled estimated.
 */
export function estimateMaxHeartRate(age: number): number {
  return Math.round(208 - 0.7 * age);
}
