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
  claims: z.array(z.object({ kind: claimKindSchema, text: z.string() })).optional(),
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

/**
 * Deleting an account.
 *
 * The password is required even though the request already carries a valid
 * token. A bearer token is a thing that can be copied off a device; it should
 * be enough to read an athlete's training and not enough to erase their
 * history, and the one action here that cannot be undone is the one worth
 * asking twice about.
 *
 * `confirm` is the athlete's own word for what they are doing. It exists so a
 * client cannot delete an account by replaying a sign-in body, which would
 * otherwise validate against a password-only schema.
 */
export const deleteAccountSchema = z.object({
  password: z.string().min(1),
  confirm: z.literal('DELETE'),
});
export type DeleteAccountDto = z.infer<typeof deleteAccountSchema>;

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

// ---------------------------------------------------------------------------
// Body composition
// ---------------------------------------------------------------------------

/**
 * The four sides of a body photo set.
 *
 * Fixed rather than free text because the comparison view pairs a session's
 * front against the other session's front. A fifth side, or a typo, would have
 * nothing to pair with.
 */
export const photoSideSchema = z.enum(['front', 'back', 'left', 'right']);
export type PhotoSideDto = z.infer<typeof photoSideSchema>;

export const PHOTO_SIDES = photoSideSchema.options;

/**
 * Metadata accompanying a photo upload.
 *
 * The files themselves travel as multipart parts, not in this object — a body
 * photo base64'd into JSON inflates by a third and has to be held in memory as
 * a string before it can be written anywhere.
 *
 * `capturedAt` is optional and defaults to arrival time. A client that has been
 * offline since the morning should be able to say when the photos were actually
 * taken, but it must not be required to.
 */
export const createCompositionSessionSchema = z.object({
  capturedAt: isoDateTime.optional(),
  /** The athlete's calendar day. Derived from their timezone when omitted. */
  localDate: localDate.optional(),
  note: z.string().max(1000).optional(),
});
export type CreateCompositionSessionDto = z.infer<typeof createCompositionSessionSchema>;

export const compositionPhotoSchema = z.object({
  id: z.string(),
  side: photoSideSchema,
  contentType: z.string(),
  byteSize: z.number().int().nonnegative(),
  capturedAt: isoDateTime,
  /** Authenticated route that serves the bytes. Never a storage path. */
  url: z.string(),
});
export type CompositionPhotoDto = z.infer<typeof compositionPhotoSchema>;

/**
 * Unit a circumference was read in.
 *
 * Distinct from the metric/imperial preference used for running distance: an
 * athlete can reasonably want kilometres for their long run and inches round
 * their waist, so the two never share a value.
 */
export const lengthUnitSchema = z.enum(['cm', 'in']);
export type LengthUnitDto = z.infer<typeof lengthUnitSchema>;

/**
 * Plausible range for a human circumference, per unit.
 *
 * Wide on purpose — this is a typo guard, not a judgement about bodies. It
 * catches a decimal point in the wrong place (864 instead of 86.4) and a value
 * entered in the wrong unit, and nothing else. Expressed per unit rather than
 * by converting, because this package deliberately depends on nothing but Zod.
 */
export const CIRCUMFERENCE_BOUNDS = {
  cm: { min: 5, max: 300 },
  in: { min: 2, max: 118 },
} as const;

export const circumferencePointSchema = z.object({
  id: z.string(),
  /** Stable identifier the client keys on, e.g. `waist`. */
  code: z.string(),
  label: z.string(),
  /** Where to put the tape. Shown next to the input, not behind a tooltip. */
  guideText: z.string(),
  sortOrder: z.number().int(),
});
export type CircumferencePointDto = z.infer<typeof circumferencePointSchema>;

export const compositionMeasurementSchema = z.object({
  id: z.string(),
  pointId: z.string(),
  pointCode: z.string(),
  /** Canonical centimetres. Always comparable, whatever it was typed in. */
  valueCm: z.number(),
  /** What the athlete actually read off the tape. */
  recordedUnit: lengthUnitSchema,
  capturedAt: isoDateTime,
});
export type CompositionMeasurementDto = z.infer<typeof compositionMeasurementSchema>;

/**
 * Record or correct one circumference.
 *
 * The wire carries `value` and `unit` — what the athlete actually entered —
 * rather than a pre-converted centimetre figure. That keeps the auditable fact
 * on the wire, puts the conversion in exactly one place, and means a client
 * that converts wrongly cannot write a corrupted canonical value.
 *
 * `capturedAt` defaults to the session's own capture time server-side. A
 * correction made months later must not restamp the measurement with the time
 * of the correction.
 */
export const recordMeasurementSchema = z
  .object({
    /** The measure point's stable code, e.g. `waist`. */
    pointCode: z.string().min(1).max(64),
    value: z.number().positive().finite(),
    unit: lengthUnitSchema.default('cm'),
    capturedAt: isoDateTime.optional(),
  })
  .superRefine((data, ctx) => {
    const bounds = CIRCUMFERENCE_BOUNDS[data.unit];
    if (data.value < bounds.min || data.value > bounds.max) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `Expected a measurement between ${bounds.min} and ${bounds.max} ${data.unit}.`,
      });
    }
  });
export type RecordMeasurementDto = z.infer<typeof recordMeasurementSchema>;

/**
 * Record several circumferences at once, as saving a session does.
 *
 * Each point may appear once. A payload naming the waist twice has no correct
 * interpretation, and silently keeping the last one would hide a client bug
 * behind plausible-looking data.
 */
export const recordMeasurementsSchema = z
  .object({ measurements: z.array(recordMeasurementSchema).min(1).max(50) })
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    data.measurements.forEach((measurement, index) => {
      if (seen.has(measurement.pointCode)) {
        ctx.addIssue({
          code: 'custom',
          path: ['measurements', index, 'pointCode'],
          message: `Measure point "${measurement.pointCode}" appears more than once.`,
        });
      }
      seen.add(measurement.pointCode);
    });
  });
export type RecordMeasurementsDto = z.infer<typeof recordMeasurementsSchema>;

/**
 * One entry in a measure point's history.
 *
 * `changeCm` is the difference from the next-older session that measured the
 * same point, computed in centimetres so it is the same number regardless of
 * how either session was typed in. Absent on the oldest entry — which is not
 * the same as a change of zero, and the two must stay distinguishable.
 */
export const metricHistoryEntrySchema = z.object({
  sessionId: z.string(),
  capturedAt: isoDateTime,
  localDate: localDate,
  valueCm: z.number(),
  recordedUnit: lengthUnitSchema,
  changeCm: z.number().optional(),
});
export type MetricHistoryEntryDto = z.infer<typeof metricHistoryEntrySchema>;

export const metricHistorySchema = z.object({
  point: circumferencePointSchema,
  entries: z.array(metricHistoryEntrySchema),
});
export type MetricHistoryDto = z.infer<typeof metricHistorySchema>;

export const compositionSessionSchema = z.object({
  id: z.string(),
  capturedAt: isoDateTime,
  localDate: localDate,
  note: z.string().optional(),
  photos: z.array(compositionPhotoSchema),
  measurements: z.array(compositionMeasurementSchema),
});
export type CompositionSessionDto = z.infer<typeof compositionSessionSchema>;

// ---------------------------------------------------------------------------
// Body fat
// ---------------------------------------------------------------------------

/** Unit a body weight was read in. Separate from every other unit preference. */
export const massUnitSchema = z.enum(['kg', 'lb']);
export type MassUnitDto = z.infer<typeof massUnitSchema>;

/**
 * How an estimate was produced.
 *
 * Three values rather than the PRD's `formula` and `ai`, because the plan asks
 * for two circumference equations and they read different measurements. Storing
 * both under one `formula` label would mean a session could hold only one of
 * them, and an athlete comparing the two would lose whichever ran second.
 */
export const bodyFatMethodSchema = z.enum(['navy', 'ymca', 'ai']);
export type BodyFatMethodDto = z.infer<typeof bodyFatMethodSchema>;

/** The two circumference equations, as distinct from the photo path. */
export const circumferenceMethodSchema = z.enum(['navy', 'ymca']);
export type CircumferenceMethodDto = z.infer<typeof circumferenceMethodSchema>;

/**
 * Which of a published equation's coefficient sets to apply.
 *
 * Named after the reference populations the equations were fitted on, because
 * that is what the choice is. It is not a field about the athlete.
 */
export const formulaVariantSchema = z.enum(['male', 'female']);
export type FormulaVariantDto = z.infer<typeof formulaVariantSchema>;

export const confidenceLabelSchema = z.enum(['low', 'moderate', 'high']);
export const serviceStatusSchema = z.enum(['active', 'unavailable', 'failed']);

/** A quantity as the athlete entered it, with the unit they read it in. */
const enteredLength = z.object({ value: z.number().positive().finite(), unit: lengthUnitSchema });
const enteredMass = z.object({ value: z.number().positive().finite(), unit: massUnitSchema });

/**
 * Ask the server to run a circumference equation over a session.
 *
 * Height and weight travel as the athlete entered them, with their unit, for
 * the same reason measurements do: the conversion belongs in one place, and a
 * client that converts wrongly should not be able to write a corrupted value.
 * The circumferences are not sent at all — they are already on the session.
 */
export const calculateBodyFatSchema = z.object({
  method: circumferenceMethodSchema,
  variant: formulaVariantSchema,
  height: enteredLength.optional(),
  weight: enteredMass.optional(),
});
export type CalculateBodyFatDto = z.infer<typeof calculateBodyFatSchema>;

export const calculationStepSchema = z.object({
  label: z.string(),
  /** The arithmetic with the numbers filled in, for the athlete to follow. */
  expression: z.string(),
  value: z.number(),
  unit: z.string().optional(),
});
export type CalculationStepDto = z.infer<typeof calculationStepSchema>;

/**
 * A stored estimate.
 *
 * A band and no single figure, matching the table it comes from: every method
 * here is built from proxies and none of them measures body fat.
 */
export const bodyFatEstimateSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  method: bodyFatMethodSchema,
  valueLow: z.number(),
  valueHigh: z.number(),
  confidence: confidenceLabelSchema,
  serviceStatus: serviceStatusSchema.optional(),
  basis: z.string(),
  /** Every step that produced a formula result. Absent for the photo path. */
  steps: z.array(calculationStepSchema).optional(),
  createdAt: isoDateTime,
});
export type BodyFatEstimateDto = z.infer<typeof bodyFatEstimateSchema>;

/**
 * One session's estimate, as it appears in a history.
 *
 * Carries the session's own date rather than when the estimate was computed: a
 * formula re-run in September on June's measurements describes June, and
 * plotting it at the September end of a chart would misplace it entirely.
 */
export const bodyFatHistoryEntrySchema = z.object({
  sessionId: z.string(),
  capturedAt: isoDateTime,
  localDate: localDate,
  method: bodyFatMethodSchema,
  valueLow: z.number(),
  valueHigh: z.number(),
  confidence: confidenceLabelSchema,
});
export type BodyFatHistoryEntryDto = z.infer<typeof bodyFatHistoryEntrySchema>;

export const bodyFatHistorySchema = z.object({
  entries: z.array(bodyFatHistoryEntrySchema),
  /** Methods present in the history, so a client can offer only real choices. */
  methods: z.array(bodyFatMethodSchema),
});
export type BodyFatHistoryDto = z.infer<typeof bodyFatHistorySchema>;

// ---------------------------------------------------------------------------
// Session comparison
// ---------------------------------------------------------------------------

/**
 * Which way a measurement went between two sessions.
 *
 * `steady` is a positive finding, not a missing answer: the value did not move
 * by more than a tape can resolve. It is distinct from having no change to
 * report at all, which shows up as an absent `changeCm` and never as `steady`.
 */
export const changeDirectionSchema = z.enum(['up', 'down', 'steady']);
export type ChangeDirectionDto = z.infer<typeof changeDirectionSchema>;

/**
 * One measure point across two sessions.
 *
 * Three shapes, and the middle one is why this is not just a number: both
 * sessions measured it and there is a change; only one did, so there is a value
 * but nothing to compare it against; or neither did. A point measured once must
 * never come back as a change of zero — an athlete who skipped their thigh in
 * June would read that as three months of nothing happening.
 */
export const comparisonRowSchema = z.object({
  pointCode: z.string(),
  pointLabel: z.string(),
  /** Canonical centimetres in the earlier session, when it measured this. */
  fromCm: z.number().optional(),
  toCm: z.number().optional(),
  /** Present only when both sessions measured the point. */
  changeCm: z.number().optional(),
  /** Present only alongside `changeCm`. */
  direction: changeDirectionSchema.optional(),
});
export type ComparisonRowDto = z.infer<typeof comparisonRowSchema>;

/** A session, reduced to what a comparison header needs. */
export const comparisonSessionSchema = z.object({
  id: z.string(),
  capturedAt: isoDateTime,
  localDate: localDate,
});

/**
 * What the comparison found, counted rather than judged.
 *
 * Counts an athlete can check against the rows, not adjectives. Nothing here
 * decides whether a direction is good news: a waist coming down and an arm
 * coming down are not the same thing, and the server cannot know which the
 * athlete was training for.
 */
export const comparisonSummarySchema = z.object({
  movedCount: z.number().int().nonnegative(),
  steadyCount: z.number().int().nonnegative(),
  /** Points one session has and the other does not. */
  onlyOneSessionCount: z.number().int().nonnegative(),
  /** Total across every comparable point. Absent when none are comparable. */
  totalChangeCm: z.number().optional(),
  /** The noise floor applied, so "steady" is not a black box. */
  thresholdCm: z.number(),
  headline: z.string(),
});
export type ComparisonSummaryDto = z.infer<typeof comparisonSummarySchema>;

/**
 * Two sessions' photos, paired by side.
 *
 * All four sides come back whether or not both photos exist. Dropping the ones
 * that cannot be paired would make a half-photographed session look complete.
 */
export const photoPairSchema = z.object({
  side: photoSideSchema,
  earlier: compositionPhotoSchema.optional(),
  later: compositionPhotoSchema.optional(),
  comparable: z.boolean(),
});
export type PhotoPairDto = z.infer<typeof photoPairSchema>;

export const sessionComparisonSchema = z.object({
  earlier: comparisonSessionSchema,
  later: comparisonSessionSchema,
  daysApart: z.number().int().nonnegative(),
  rows: z.array(comparisonRowSchema),
  photos: z.array(photoPairSchema),
  summary: comparisonSummarySchema,
});
export type SessionComparisonDto = z.infer<typeof sessionComparisonSchema>;

/**
 * A session as the comparison picker needs it.
 *
 * Counts rather than contents: a picker showing ten sessions does not need
 * forty photo records and sixty measurements to render ten rows, and asking
 * for them would make opening the picker the most expensive thing on the
 * screen.
 *
 * `comparable` is false for a session with nothing recorded in it. Offering it
 * as a choice would let an athlete pick a pair that can produce no comparison,
 * and then wonder why the screen is empty.
 */
export const comparisonOptionSchema = z.object({
  id: z.string(),
  capturedAt: isoDateTime,
  localDate: localDate,
  note: z.string().optional(),
  photoCount: z.number().int().nonnegative(),
  measurementCount: z.number().int().nonnegative(),
  estimateCount: z.number().int().nonnegative(),
  comparable: z.boolean(),
});
export type ComparisonOptionDto = z.infer<typeof comparisonOptionSchema>;

/**
 * Which two sessions to compare.
 *
 * Either two ids or a window. A window resolves to its widest pair, because
 * "the last three months" means the span of that window and not the two most
 * recent sessions that happen to fall inside it.
 */
export const compareSessionsQuerySchema = z
  .object({
    earlierId: z.string().optional(),
    laterId: z.string().optional(),
    /** Window length in days. Omit both this and the ids for all time. */
    days: z.coerce.number().int().positive().optional(),
  })
  .superRefine((data, ctx) => {
    const hasOne = Boolean(data.earlierId) !== Boolean(data.laterId);
    if (hasOne) {
      ctx.addIssue({
        code: 'custom',
        path: ['earlierId'],
        message: 'Give both session ids or neither.',
      });
    }
    if (data.earlierId && data.earlierId === data.laterId) {
      // A session compared against itself is a column of zeroes, which looks
      // like a finding and is not one.
      ctx.addIssue({
        code: 'custom',
        path: ['laterId'],
        message: 'Pick two different sessions.',
      });
    }
  });
export type CompareSessionsQueryDto = z.infer<typeof compareSessionsQuerySchema>;

/**
 * A point on a trend line.
 *
 * `changeCm` is the move from the previous reading, computed in canonical
 * units. Absent on the oldest point, which has nothing to compare against —
 * distinct from a change of zero, and the two must stay distinguishable.
 */
export const trendPointSchema = z.object({
  capturedAt: isoDateTime,
  localDate: localDate,
  value: z.number(),
  changeCm: z.number().optional(),
});
export type TrendPointDto = z.infer<typeof trendPointSchema>;

/** A point on a band, for a metric that has no single value. */
export const trendBandPointSchema = z.object({
  capturedAt: isoDateTime,
  localDate: localDate,
  low: z.number(),
  high: z.number(),
});
export type TrendBandPointDto = z.infer<typeof trendBandPointSchema>;

/**
 * One metric over time.
 *
 * Exactly one of `points` and `band` is present. Body fat comes back as a band
 * because the estimate has no single value; everything else is a line.
 *
 * One metric per response, and the unit travels with it. Centimetres,
 * kilograms and a percentage never share an axis: the alignment between two
 * scales is arbitrary, so a chart drawing two of them together invents a
 * correlation that is not in the data.
 */
export const trendSeriesSchema = z.object({
  metric: z.string(),
  label: z.string(),
  unit: z.string(),
  points: z.array(trendPointSchema).optional(),
  band: z.array(trendBandPointSchema).optional(),
});
export type TrendSeriesDto = z.infer<typeof trendSeriesSchema>;

// ---------------------------------------------------------------------------
// Composition privacy
// ---------------------------------------------------------------------------

/**
 * What one session holds, for the screen that asks "what have you got of mine".
 *
 * Counts rather than contents, and `onServer` so an athlete can tell which
 * sessions include photographs — that is the distinction they care about, and
 * "some of your data is stored" is not an answer.
 */
export const sessionInventorySchema = z.object({
  sessionId: z.string(),
  capturedAt: isoDateTime,
  localDate: localDate,
  photoCount: z.number().int().nonnegative(),
  measurementCount: z.number().int().nonnegative(),
  estimateCount: z.number().int().nonnegative(),
  /** True when this session has photos, which are held server-side. */
  onServer: z.boolean(),
});
export type SessionInventoryDto = z.infer<typeof sessionInventorySchema>;

export const compositionInventorySchema = z.object({
  sessions: z.array(sessionInventorySchema),
  totals: z.object({
    sessionCount: z.number().int().nonnegative(),
    photoCount: z.number().int().nonnegative(),
    measurementCount: z.number().int().nonnegative(),
    estimateCount: z.number().int().nonnegative(),
    /** Total bytes of stored photos, so "how much" has a real answer. */
    photoBytes: z.number().int().nonnegative(),
  }),
});
export type CompositionInventoryDto = z.infer<typeof compositionInventorySchema>;

/**
 * What a deletion actually removed.
 *
 * Returned rather than a bare success, because on a deletion endpoint the
 * athlete is trusting a claim they cannot verify. Counts they can check against
 * the inventory they were just shown are the nearest thing to proof this API
 * can offer.
 */
export const deletionReceiptSchema = z.object({
  sessionsDeleted: z.number().int().nonnegative(),
  photosDeleted: z.number().int().nonnegative(),
  measurementsDeleted: z.number().int().nonnegative(),
  estimatesDeleted: z.number().int().nonnegative(),
  /** Photo files removed from storage, counted separately from their rows. */
  filesDeleted: z.number().int().nonnegative(),
  /**
   * Files the database expected and storage did not have.
   *
   * Reported rather than swallowed: it means a previous delete was interrupted
   * or something went wrong, and hiding it would let the discrepancy grow
   * unseen.
   */
  filesMissing: z.number().int().nonnegative(),
});
export type DeletionReceiptDto = z.infer<typeof deletionReceiptSchema>;

/**
 * Confirmation required before deleting everything.
 *
 * A destructive endpoint with no undo should not be reachable by a mistyped
 * URL or a stray retry, so the caller has to state what they intend.
 */
export const purgeCompositionSchema = z.object({
  confirm: z.literal('delete my composition data'),
});
export type PurgeCompositionDto = z.infer<typeof purgeCompositionSchema>;

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
