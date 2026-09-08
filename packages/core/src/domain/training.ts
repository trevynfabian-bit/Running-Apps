/**
 * Training plan structure: goals, periodised blocks, and the sessions inside them.
 */

import type { PlannedWorkout } from './workout.js';

/** Classic endurance periodisation phases. */
export const TRAINING_BLOCK_TYPES = [
  'base',
  'build',
  'specific',
  'peak',
  'taper',
  'race',
  'recovery',
] as const;

export type TrainingBlockType = (typeof TRAINING_BLOCK_TYPES)[number];

export const PROGRAM_TEMPLATES = [
  'beginner_5k',
  'improve_5k',
  'road_10k',
  'half_marathon',
  'marathon',
  'aerobic_base',
  'return_to_running',
  'general_fitness',
  'custom',
] as const;

export type ProgramTemplateId = (typeof PROGRAM_TEMPLATES)[number];

export interface TrainingBlock {
  id: string;
  planId: string;
  type: TrainingBlockType;
  name: string;
  /** One-line statement of the adaptation this block is chasing. */
  goal: string;
  /** Local dates `YYYY-MM-DD`, inclusive. */
  startDate: string;
  endDate: string;
  durationWeeks: number;
  orderIndex: number;
  /** Planned weekly volume for each week of the block, in metres. */
  weeklyDistanceTargetsMeters: number[];
}

export type PlanStatus = 'draft' | 'active' | 'completed' | 'abandoned';

export interface TrainingPlan {
  id: string;
  athleteId: string;
  name: string;
  template: ProgramTemplateId;
  status: PlanStatus;
  /** Local dates `YYYY-MM-DD`. */
  startDate: string;
  endDate: string;
  raceGoalId?: string;
  blocks: TrainingBlock[];
  workouts: PlannedWorkout[];
  /** Snapshot of the inputs the plan was generated from, for explainability. */
  generationBasis: {
    weeklyDistanceMetersAtStart: number;
    sessionsPerWeek: number;
    estimatedThresholdPaceSecondsPerKm?: number;
    estimatedEasyPaceSecondsPerKm?: number;
    notes: string[];
  };
  createdAt: Date;
  updatedAt: Date;
}

/** Where the athlete currently sits inside their plan. */
export interface PlanPosition {
  block: TrainingBlock;
  /** 1-based week index within the block. */
  weekInBlock: number;
  weeksInBlock: number;
  /** 1-based week index within the whole plan. */
  weekInPlan: number;
  weeksInPlan: number;
  weeklyDistanceTargetMeters: number;
}

/** Weekly rollup of planned vs actual. */
export interface WeeklySummary {
  /** ISO week key, e.g. `2026-W33`. */
  weekKey: string;
  /** Monday of the week, local date. */
  weekStart: string;
  plannedDistanceMeters: number;
  completedDistanceMeters: number;
  plannedSessions: number;
  completedSessions: number;
  longestRunMeters: number;
  qualitySessions: number;
  totalTrainingLoad: number;
  totalDurationSeconds: number;
  /** Share of running time spent at or above threshold intensity, 0..1. */
  highIntensityShare?: number;
}
