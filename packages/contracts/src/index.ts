/**
 * @running/contracts — the wire format between the mobile app and the API.
 *
 * Zod schemas are the single source of truth: the API validates against them
 * on the way in, and the app derives its types from them. A field can't drift
 * between client and server without breaking the build on both sides.
 *
 * Dates cross the wire as ISO-8601 strings and are parsed at the edges.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const isoDateTime = z.string().datetime({ offset: true }).or(z.string().datetime());
/** Local calendar date, `YYYY-MM-DD`. */
export const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const providerIdSchema = z.enum(['strava', 'whoop', 'healthkit', 'manual', 'derived']);
export type ProviderIdDto = z.infer<typeof providerIdSchema>;

export const confidenceSchema = z.enum(['low', 'moderate', 'high']);

export const workoutTypeSchema = z.enum([
  'easy',
  'recovery',
  'long',
  'progression',
  'tempo',
  'threshold',
  'intervals',
  'hills',
  'strides',
  'fartlek',
  'race_simulation',
  'time_trial',
  'race',
  'treadmill',
  'rest',
  'cross_training',
  'strength',
]);

export const sportTypeSchema = z.enum(['run', 'walk', 'ride', 'swim', 'strength', 'other']);

export const decisionTypeSchema = z.enum([
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
]);

export const trainingStateSchema = z.enum([
  'fresh',
  'normal',
  'building',
  'fatigued',
  'highly_fatigued',
  'undertrained',
  'overreaching_risk',
]);

export const recoveryBandSchema = z.enum(['green', 'yellow', 'red']);

// ---------------------------------------------------------------------------
// Athlete
// ---------------------------------------------------------------------------

export const dayOfWeekSchema = z.number().int().min(0).max(6);

export const availabilitySchema = z.object({
  runDays: z.array(dayOfWeekSchema),
  longRunDay: dayOfWeekSchema,
  restDays: z.array(dayOfWeekSchema),
  strengthDays: z.array(dayOfWeekSchema),
  crossTrainingDays: z.array(dayOfWeekSchema),
  maxSessionsPerWeek: z.number().int().min(0).max(14),
  typicalWeekdayMinutes: z.number().int().positive().optional(),
  typicalLongRunMinutes: z.number().int().positive().optional(),
  preferredTimeOfDay: z.enum(['early_morning', 'morning', 'midday', 'evening']).optional(),
});

export const constraintsSchema = z.object({
  injuryNotes: z.string().max(2000).optional(),
  activePain: z.boolean(),
  hasTreadmillAccess: z.boolean(),
  hasTrackAccess: z.boolean(),
  hasGymAccess: z.boolean(),
  surfacePreference: z.enum(['road', 'trail', 'track', 'treadmill', 'mixed']),
  unavailableDates: z.array(localDate),
});

export const backgroundSchema = z.object({
  experience: z.enum(['beginner', 'returning', 'recreational', 'experienced', 'competitive']),
  typicalWeeklyDistanceMeters: z.number().nonnegative().optional(),
  typicalSessionsPerWeek: z.number().int().min(0).max(14).optional(),
  longestRecentRunMeters: z.number().nonnegative().optional(),
  selfReportedEasyPaceSecondsPerKm: z.number().positive().optional(),
  yearsRunning: z.number().nonnegative().optional(),
});

export const preferencesSchema = z.object({
  units: z.enum(['metric', 'imperial']),
  primaryZoneMethodology: z.enum([
    'max_hr_percent',
    'hr_reserve',
    'threshold_hr',
    'pace_threshold',
    'pace_vdot',
  ]),
  timezone: z.string().min(1),
  notifications: z.object({
    dailyWorkout: z.boolean(),
    morningCheckIn: z.boolean(),
    weeklyReview: z.boolean(),
    planAdjustments: z.boolean(),
    syncFailures: z.boolean(),
  }),
});

export const athleteProfileSchema = z.object({
  id: z.string(),
  displayName: z.string().min(1).max(120),
  dateOfBirth: localDate.optional(),
  sex: z.enum(['male', 'female', 'unspecified']),
  background: backgroundSchema,
  availability: availabilitySchema,
  constraints: constraintsSchema,
  preferences: preferencesSchema,
  markers: z.object({
    maxHeartRateBpm: z.number().int().positive().optional(),
    restingHeartRateBpm: z.number().int().positive().optional(),
    thresholdHeartRateBpm: z.number().int().positive().optional(),
    thresholdPaceSecondsPerKm: z.number().positive().optional(),
    heightMeters: z.number().positive().optional(),
    weightKilograms: z.number().positive().optional(),
  }),
});
export type AthleteProfileDto = z.infer<typeof athleteProfileSchema>;

/** Everything on the profile is optional on update; only send what changed. */
export const updateAthleteProfileSchema = athleteProfileSchema.omit({ id: true }).partial();
export type UpdateAthleteProfileDto = z.infer<typeof updateAthleteProfileSchema>;

// ---------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------

export const workoutSourceRefSchema = z.object({
  provider: providerIdSchema,
  externalId: z.string(),
  contributedFields: z.array(z.string()),
});

export const workoutSummarySchema = z.object({
  id: z.string(),
  type: workoutTypeSchema,
  sport: sportTypeSchema,
  name: z.string().optional(),
  startTime: isoDateTime,
  endTime: isoDateTime,
  timezone: z.string(),
  localDate: localDate,
  durationSeconds: z.number().optional(),
  movingTimeSeconds: z.number().optional(),
  distanceMeters: z.number().optional(),
  avgPaceSecondsPerKm: z.number().optional(),
  avgHeartRateBpm: z.number().optional(),
  maxHeartRateBpm: z.number().optional(),
  elevationGainMeters: z.number().optional(),
  avgCadenceSpm: z.number().optional(),
  calories: z.number().optional(),
  trainingLoad: z.number().optional(),
  perceivedExertion: z.number().optional(),
  indoor: z.boolean().optional(),
  sourceRecords: z.array(workoutSourceRefSchema),
  sourceConfidence: z.number().min(0).max(1),
  plannedWorkoutId: z.string().optional(),
});
export type WorkoutSummaryDto = z.infer<typeof workoutSummarySchema>;

export const workoutAnalysisSchema = z.object({
  workoutId: z.string(),
  execution: z.object({
    plannedDistanceMeters: z.number().optional(),
    actualDistanceMeters: z.number().optional(),
    plannedDurationSeconds: z.number().optional(),
    actualDurationSeconds: z.number().optional(),
    /** How closely the session matched its prescription, 0..1. */
    adherence: z.number().min(0).max(1).optional(),
    notes: z.array(z.string()),
  }),
  efficiency: z
    .object({
      efficiencyFactor: z.number(),
      comparedToBaselinePercent: z.number().optional(),
    })
    .optional(),
  decoupling: z
    .object({
      driftPercent: z.number(),
      isValid: z.boolean(),
      invalidReason: z.string().optional(),
      interpretation: z.string(),
    })
    .optional(),
  trainingEffect: z.object({
    trainingLoad: z.number().optional(),
    loadModel: z.string().optional(),
    contributionToWeeklyTargetPercent: z.number().optional(),
  }),
  insight: z.string(),
});
export type WorkoutAnalysisDto = z.infer<typeof workoutAnalysisSchema>;

export const workoutDetailSchema = workoutSummarySchema.extend({
  splits: z
    .array(
      z.object({
        index: z.number().int(),
        distanceMeters: z.number(),
        durationSeconds: z.number(),
        avgHeartRateBpm: z.number().optional(),
        elevationGainMeters: z.number().optional(),
      }),
    )
    .optional(),
  route: z
    .array(z.object({ lat: z.number(), lon: z.number(), elevationMeters: z.number().optional() }))
    .optional(),
  analysis: workoutAnalysisSchema.optional(),
});
export type WorkoutDetailDto = z.infer<typeof workoutDetailSchema>;

export const createManualWorkoutSchema = z.object({
  type: workoutTypeSchema,
  sport: sportTypeSchema.default('run'),
  startTime: isoDateTime,
  durationSeconds: z.number().positive(),
  distanceMeters: z.number().positive().optional(),
  avgHeartRateBpm: z.number().int().positive().optional(),
  perceivedExertion: z.number().int().min(1).max(10).optional(),
  notes: z.string().max(2000).optional(),
});
export type CreateManualWorkoutDto = z.infer<typeof createManualWorkoutSchema>;

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export const intensityTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('zone'), zone: z.number().int() }),
  z.object({
    kind: z.literal('pace'),
    fastSecondsPerKm: z.number(),
    slowSecondsPerKm: z.number(),
  }),
  z.object({ kind: z.literal('heart_rate'), minBpm: z.number(), maxBpm: z.number() }),
  z.object({ kind: z.literal('rpe'), min: z.number(), max: z.number() }),
  z.object({ kind: z.literal('effort'), description: z.string() }),
]);

export const workoutStepSchema = z.object({
  id: z.string(),
  label: z.string(),
  durationSeconds: z.number().optional(),
  distanceMeters: z.number().optional(),
  target: intensityTargetSchema,
  isRecovery: z.boolean().optional(),
  notes: z.string().optional(),
});

export const workoutStructureSchema = z.object({
  warmup: workoutStepSchema.optional(),
  main: z.array(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('step'), step: workoutStepSchema }),
      z.object({
        kind: z.literal('repeat'),
        repeat: z.object({
          id: z.string(),
          repetitions: z.number().int().positive(),
          steps: z.array(workoutStepSchema),
        }),
      }),
    ]),
  ),
  cooldown: workoutStepSchema.optional(),
});

export const plannedWorkoutSchema = z.object({
  id: z.string(),
  date: localDate,
  type: workoutTypeSchema,
  title: z.string(),
  purpose: z.string(),
  targetDistanceMeters: z.number().optional(),
  targetDurationSeconds: z.number().optional(),
  targetRpe: z.number().optional(),
  structure: workoutStructureSchema.optional(),
  status: z.enum(['planned', 'completed', 'partially_completed', 'modified', 'skipped']),
  modifiedFrom: z
    .object({
      type: workoutTypeSchema,
      targetDistanceMeters: z.number().optional(),
      targetDurationSeconds: z.number().optional(),
      reason: z.string(),
    })
    .optional(),
  completedWorkoutId: z.string().optional(),
});
export type PlannedWorkoutDto = z.infer<typeof plannedWorkoutSchema>;

export const trainingBlockSchema = z.object({
  id: z.string(),
  type: z.enum(['base', 'build', 'specific', 'peak', 'taper', 'race', 'recovery']),
  name: z.string(),
  goal: z.string(),
  startDate: localDate,
  endDate: localDate,
  durationWeeks: z.number().int().positive(),
  orderIndex: z.number().int(),
  weeklyDistanceTargetsMeters: z.array(z.number()),
});

export const trainingPlanSchema = z.object({
  id: z.string(),
  name: z.string(),
  template: z.string(),
  status: z.enum(['draft', 'active', 'completed', 'abandoned']),
  startDate: localDate,
  endDate: localDate,
  raceGoalId: z.string().optional(),
  blocks: z.array(trainingBlockSchema),
  generationBasis: z.object({
    weeklyDistanceMetersAtStart: z.number(),
    sessionsPerWeek: z.number(),
    estimatedThresholdPaceSecondsPerKm: z.number().optional(),
    estimatedEasyPaceSecondsPerKm: z.number().optional(),
    notes: z.array(z.string()),
  }),
});
export type TrainingPlanDto = z.infer<typeof trainingPlanSchema>;

export const planWeekSchema = z.object({
  weekStart: localDate,
  weekKey: z.string(),
  blockName: z.string(),
  blockType: z.string(),
  weekInBlock: z.number().int(),
  weeksInBlock: z.number().int(),
  targetDistanceMeters: z.number(),
  completedDistanceMeters: z.number(),
  workouts: z.array(plannedWorkoutSchema),
});
export type PlanWeekDto = z.infer<typeof planWeekSchema>;

export const generatePlanSchema = z.object({
  template: z.enum([
    'beginner_5k',
    'improve_5k',
    'road_10k',
    'half_marathon',
    'marathon',
    'aerobic_base',
    'return_to_running',
    'general_fitness',
    'custom',
  ]),
  startDate: localDate.optional(),
  totalWeeks: z.number().int().min(1).max(52).optional(),
  raceGoalId: z.string().optional(),
});
export type GeneratePlanDto = z.infer<typeof generatePlanSchema>;

// ---------------------------------------------------------------------------
// Recovery and check-in
// ---------------------------------------------------------------------------

export const checkInSchema = z.object({
  date: localDate.optional(),
  energy: z.number().int().min(1).max(5),
  soreness: z.number().int().min(1).max(5),
  stress: z.number().int().min(1).max(5),
  motivation: z.number().int().min(1).max(5),
  hasPain: z.boolean().default(false),
  painNote: z.string().max(1000).optional(),
});
export type CheckInDto = z.infer<typeof checkInSchema>;

export const recoveryStateSchema = z.object({
  date: localDate,
  score: z.number(),
  band: recoveryBandSchema,
  components: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      score: z.number(),
      weight: z.number(),
      detail: z.string(),
    }),
  ),
  missingSignals: z.array(z.string()),
  dataCompleteness: z.number(),
  summary: z.string(),
});
export type RecoveryStateDto = z.infer<typeof recoveryStateSchema>;

// ---------------------------------------------------------------------------
// Coaching
// ---------------------------------------------------------------------------

export const reasonSchema = z.object({
  key: z.string(),
  message: z.string(),
  severity: z.enum(['info', 'caution', 'warning']),
  weight: z.number(),
  detail: z.string().optional(),
});

export const coachDecisionSchema = z.object({
  id: z.string(),
  date: localDate,
  decision: decisionTypeSchema,
  confidence: z.number(),
  reasons: z.array(reasonSchema),
  headline: z.string(),
  explanation: z.string(),
  affectedWorkoutId: z.string().optional(),
  previousPlan: plannedWorkoutSchema.optional(),
  recommendedPlan: plannedWorkoutSchema.optional(),
});
export type CoachDecisionDto = z.infer<typeof coachDecisionSchema>;

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export const dashboardSchema = z.object({
  date: localDate,
  greeting: z.string(),
  readiness: z.object({
    score: z.number(),
    band: recoveryBandSchema,
    summary: z.string(),
    dataCompleteness: z.number(),
  }),
  todayWorkout: plannedWorkoutSchema.optional(),
  decision: coachDecisionSchema.optional(),
  trainingState: z.object({
    state: trainingStateSchema,
    summary: z.string(),
    confidence: z.number(),
    recommendProfessionalReview: z.boolean(),
  }),
  weeklyProgress: z.object({
    completedDistanceMeters: z.number(),
    targetDistanceMeters: z.number(),
    completedSessions: z.number(),
    plannedSessions: z.number(),
  }),
  currentBlock: z
    .object({
      name: z.string(),
      goal: z.string(),
      weekInBlock: z.number(),
      weeksInBlock: z.number(),
    })
    .optional(),
  raceGoal: z
    .object({
      id: z.string(),
      name: z.string(),
      date: localDate,
      distanceMeters: z.number(),
      targetDurationSeconds: z.number().optional(),
      currentEstimateSeconds: z.number().optional(),
      gapSeconds: z.number().optional(),
      weeksRemaining: z.number(),
      readinessScore: z.number().optional(),
      confidence: confidenceSchema,
    })
    .optional(),
  zones: z
    .object({
      methodology: z.string(),
      kind: z.enum(['heart_rate', 'pace']),
      note: z.string().optional(),
      zones: z.array(
        z.object({
          number: z.number(),
          name: z.string(),
          purpose: z.string(),
          lowerBound: z.number(),
          upperBound: z.number(),
        }),
      ),
    })
    .optional(),
  needsCheckIn: z.boolean(),
});
export type DashboardDto = z.infer<typeof dashboardSchema>;

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export const trendSchema = z.object({
  metric: z.string(),
  current: z.number().optional(),
  baseline: z.number().optional(),
  absoluteChange: z.number().optional(),
  percentChange: z.number().optional(),
  direction: z.enum(['improving', 'stable', 'declining', 'insufficient_data']),
  confidence: confidenceSchema,
  sampleCount: z.number(),
  windowDays: z.number(),
  summary: z.string(),
});
export type TrendDto = z.infer<typeof trendSchema>;

export const seriesPointSchema = z.object({ date: localDate, value: z.number() });

export const progressSchema = z.object({
  windowDays: z.number(),
  fitness: z.object({
    estimatedVo2Max: z.number().optional(),
    thresholdPaceSecondsPerKm: z.number().optional(),
    easyPaceRangeSecondsPerKm: z.tuple([z.number(), z.number()]).optional(),
    confidence: confidenceSchema,
    basis: z.string(),
    aerobicEfficiency: trendSchema.optional(),
  }),
  training: z.object({
    weeklyDistance: z.array(seriesPointSchema),
    weeklyLoad: z.array(seriesPointSchema),
    longestRun: z.array(seriesPointSchema),
    distanceTrend: trendSchema.optional(),
  }),
  recovery: z.object({
    recoveryScore: z.array(seriesPointSchema),
    hrv: z.array(seriesPointSchema),
    restingHeartRate: z.array(seriesPointSchema),
    sleepHours: z.array(seriesPointSchema),
    hrvTrend: trendSchema.optional(),
    restingHrTrend: trendSchema.optional(),
  }),
  body: z.object({
    weightKilograms: z.array(seriesPointSchema),
    weightTrend: trendSchema.optional(),
  }),
  racePredictions: z.array(
    z.object({
      distanceMeters: z.number(),
      label: z.string(),
      predictedDurationSeconds: z.number(),
      predictedPaceSecondsPerKm: z.number(),
      confidence: confidenceSchema,
      method: z.string(),
      basis: z.string(),
    }),
  ),
});
export type ProgressDto = z.infer<typeof progressSchema>;

// ---------------------------------------------------------------------------
// Connections and sync
// ---------------------------------------------------------------------------

export const connectionStatusSchema = z.enum([
  'connected',
  'disconnected',
  'expired',
  'error',
  'syncing',
]);

export const connectionSchema = z.object({
  provider: providerIdSchema,
  status: connectionStatusSchema,
  connectedAt: isoDateTime.optional(),
  lastSyncedAt: isoDateTime.optional(),
  lastSyncError: z.string().optional(),
  scopes: z.array(z.string()),
  /** Athlete-facing description of what this connection reads. */
  dataDescription: z.array(z.string()),
  recordCounts: z.record(z.string(), z.number()).optional(),
});
export type ConnectionDto = z.infer<typeof connectionSchema>;

export const syncResultSchema = z.object({
  provider: providerIdSchema,
  started: isoDateTime,
  finished: isoDateTime.optional(),
  status: z.enum(['success', 'partial', 'failed', 'running']),
  recordsFetched: z.number(),
  recordsCreated: z.number(),
  recordsUpdated: z.number(),
  duplicatesMerged: z.number(),
  errors: z.array(z.string()),
});
export type SyncResultDto = z.infer<typeof syncResultSchema>;

// ---------------------------------------------------------------------------
// AI coach
// ---------------------------------------------------------------------------

export const coachMessageSchema = z.object({
  message: z.string().min(1).max(4000),
});
export type CoachMessageDto = z.infer<typeof coachMessageSchema>;

export const claimKindSchema = z.enum([
  'fact',
  'derived',
  'estimate',
  'interpretation',
  'recommendation',
]);

export const coachResponseSchema = z.object({
  answer: z.string(),
  /**
   * Statements tagged by epistemic status, so the UI can visually separate a
   * measurement from an inference.
   */
  claims: z
    .array(z.object({ kind: claimKindSchema, text: z.string() }))
    .optional(),
  keyMetrics: z
    .array(z.object({ label: z.string(), value: z.string(), context: z.string().optional() }))
    .optional(),
  recommendation: z.string().optional(),
  confidence: confidenceSchema.optional(),
  /** Named data the answer was grounded in. */
  dataUsed: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  /** True when the deterministic fallback answered instead of the LLM. */
  generatedWithoutLlm: z.boolean().optional(),
});
export type CoachResponseDto = z.infer<typeof coachResponseSchema>;

// ---------------------------------------------------------------------------
// Race goals
// ---------------------------------------------------------------------------

export const createRaceGoalSchema = z.object({
  name: z.string().min(1).max(200),
  date: localDate,
  distanceMeters: z.number().positive(),
  targetDurationSeconds: z.number().positive().optional(),
  priority: z.enum(['A', 'B', 'C']).default('A'),
  notes: z.string().max(2000).optional(),
});
export type CreateRaceGoalDto = z.infer<typeof createRaceGoalSchema>;

export const raceGoalSchema = createRaceGoalSchema.extend({
  id: z.string(),
  status: z.enum(['upcoming', 'completed', 'cancelled']),
  weeksRemaining: z.number(),
  targetPaceSecondsPerKm: z.number().optional(),
  currentEstimateSeconds: z.number().optional(),
  gapSeconds: z.number().optional(),
  confidence: confidenceSchema,
  targetLooksUnrealistic: z.boolean(),
  note: z.string(),
  readiness: z
    .object({
      score: z.number(),
      summary: z.string(),
      factors: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          score: z.number(),
          weight: z.number(),
          detail: z.string(),
        }),
      ),
    })
    .optional(),
});
export type RaceGoalDto = z.infer<typeof raceGoalSchema>;

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export const weeklyReviewSchema = z.object({
  weekKey: z.string(),
  weekStart: localDate,
  assessment: z.string(),
  headline: z.string(),
  completionRate: z.number(),
  distanceChangePercent: z.number().optional(),
  averageRecoveryScore: z.number().optional(),
  averageSleepSeconds: z.number().optional(),
  summary: z.object({
    completedDistanceMeters: z.number(),
    plannedDistanceMeters: z.number(),
    completedSessions: z.number(),
    plannedSessions: z.number(),
    longestRunMeters: z.number(),
    qualitySessions: z.number(),
    totalTrainingLoad: z.number(),
    totalDurationSeconds: z.number(),
  }),
  whatWentWell: z.array(z.string()),
  whatNeedsAttention: z.array(z.string()),
  keyAdaptation: z.string(),
  nextWeekPriority: z.string(),
});
export type WeeklyReviewDto = z.infer<typeof weeklyReviewSchema>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const signUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10, 'Use at least 10 characters'),
  displayName: z.string().min(1).max(120),
});
export type SignUpDto = z.infer<typeof signUpSchema>;

export const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type SignInDto = z.infer<typeof signInSchema>;

export const authResponseSchema = z.object({
  token: z.string(),
  expiresAt: isoDateTime,
  user: z.object({ id: z.string(), email: z.string(), displayName: z.string() }),
  hasCompletedOnboarding: z.boolean(),
});
export type AuthResponseDto = z.infer<typeof authResponseSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Uniform error envelope. `code` is stable and machine-readable; `message` is
 * athlete-facing and must never contain a stack trace or provider internals.
 */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiErrorDto = z.infer<typeof apiErrorSchema>;

export const API_ERROR_CODES = {
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  VALIDATION_FAILED: 'validation_failed',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  PROVIDER_NOT_CONNECTED: 'provider_not_connected',
  TOKEN_EXPIRED: 'token_expired',
  RATE_LIMITED: 'rate_limited',
  CONFLICT: 'conflict',
  INTERNAL: 'internal_error',
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];
