/**
 * Database schema (PostgreSQL via Drizzle).
 *
 * Conventions
 * -----------
 * - All timestamps are `timestamptz` and stored in UTC. Local dates that
 *   represent a training day are stored as `date` in the athlete's timezone,
 *   because "which day was this run on" is a local-calendar question.
 * - Every provider-sourced table has a unique constraint on
 *   (connection, external id) so a replayed webhook or an overlapping sync
 *   window can never create a duplicate row. Idempotency is enforced by the
 *   database, not by application logic.
 * - Raw provider payloads are retained alongside normalised columns so a
 *   normalisation bug can be fixed and replayed without re-fetching.
 */

import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),

    /**
     * Tokens issued before this instant are refused.
     *
     * Bearer tokens are self-contained and live for thirty days, so without a
     * row to check against there is no way to take one back. Signing out would
     * clear the phone and leave the token that reads body photographs working
     * until it expired on its own. Moving this forward invalidates every token
     * the account has ever been given, in one write.
     */
    tokensValidFrom: timestamp('tokens_valid_from', { withTimezone: true })
      .notNull()
      .defaultNow(),

    createdAt,
    updatedAt,
  },
  (t) => [uniqueIndex('users_email_unique').on(t.email)],
);

export const athleteProfiles = pgTable(
  'athlete_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    dateOfBirth: date('date_of_birth'),
    sex: text('sex').notNull().default('unspecified'),
    timezone: text('timezone').notNull().default('UTC'),
    units: text('units').notNull().default('metric'),
    zoneMethodology: text('zone_methodology').notNull().default('hr_reserve'),

    background: jsonb('background').notNull().default({}),
    availability: jsonb('availability').notNull().default({}),
    constraints: jsonb('constraints').notNull().default({}),
    notifications: jsonb('notifications').notNull().default({}),

    maxHeartRateBpm: integer('max_heart_rate_bpm'),
    restingHeartRateBpm: integer('resting_heart_rate_bpm'),
    thresholdHeartRateBpm: integer('threshold_heart_rate_bpm'),
    thresholdPaceSecondsPerKm: real('threshold_pace_seconds_per_km'),

    hasCompletedOnboarding: boolean('has_completed_onboarding').notNull().default(false),
    createdAt,
    updatedAt,
  },
  (t) => [uniqueIndex('athlete_profiles_user_unique').on(t.userId)],
);

/**
 * Body and physiological measurements, one row per observation per provider.
 * Kept append-only so provenance and conflicting sources are both preserved;
 * resolution happens at read time via the provenance engine.
 */
export const bodyMeasurements = pgTable(
  'body_measurements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    metric: text('metric').notNull(), // weight_kg | height_m | max_hr | resting_hr
    provider: text('provider').notNull(),
    originalValue: doublePrecision('original_value').notNull(),
    normalizedValue: doublePrecision('normalized_value').notNull(),
    transformation: text('transformation'),
    measuredAt: timestamp('measured_at', { withTimezone: true }).notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt,
  },
  (t) => [
    index('body_measurements_lookup').on(t.athleteId, t.metric, t.measuredAt),
    // One observation per provider per metric per instant.
    uniqueIndex('body_measurements_unique').on(t.athleteId, t.metric, t.provider, t.measuredAt),
  ],
);

// ---------------------------------------------------------------------------
// Provider connections
// ---------------------------------------------------------------------------

export const providerConnections = pgTable(
  'provider_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    status: text('status').notNull().default('disconnected'),
    /** The provider's own user id, needed to route inbound webhooks. */
    externalUserId: text('external_user_id'),
    scopes: jsonb('scopes').notNull().default([]),

    /**
     * OAuth tokens, encrypted at rest with AES-256-GCM. Never selected into
     * any response DTO — only the token service reads these columns.
     */
    accessTokenEncrypted: text('access_token_encrypted'),
    refreshTokenEncrypted: text('refresh_token_encrypted'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),

    connectedAt: timestamp('connected_at', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastSyncError: text('last_sync_error'),
    /** Provider-specific incremental cursor (page token, high-water mark). */
    syncCursor: jsonb('sync_cursor'),
    createdAt,
    updatedAt,
  },
  (t) => [uniqueIndex('provider_connections_unique').on(t.athleteId, t.provider)],
);

// ---------------------------------------------------------------------------
// Raw provider records
// ---------------------------------------------------------------------------

export const stravaActivities = pgTable(
  'strava_activities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => providerConnections.id, { onDelete: 'cascade' }),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    name: text('name'),
    sportType: text('sport_type'),
    startDate: timestamp('start_date', { withTimezone: true }).notNull(),
    timezone: text('timezone'),
    elapsedTimeSeconds: integer('elapsed_time_seconds'),
    movingTimeSeconds: integer('moving_time_seconds'),
    distanceMeters: doublePrecision('distance_meters'),
    totalElevationGainMeters: doublePrecision('total_elevation_gain_meters'),
    averageHeartRate: real('average_heart_rate'),
    maxHeartRate: real('max_heart_rate'),
    averageCadence: real('average_cadence'),
    averageWatts: real('average_watts'),
    calories: real('calories'),
    sufferScore: real('suffer_score'),
    trainer: boolean('trainer'),
    /** Encoded polyline of the route, decoded lazily. */
    summaryPolyline: text('summary_polyline'),
    splits: jsonb('splits'),
    raw: jsonb('raw').notNull(),
    /** Set when Strava tells us the activity was deleted. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex('strava_activities_external_unique').on(t.connectionId, t.externalId),
    index('strava_activities_athlete_start').on(t.athleteId, t.startDate),
  ],
);

export const whoopCycles = pgTable(
  'whoop_cycles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => providerConnections.id, { onDelete: 'cascade' }),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    /** WHOOP v2 cycle ids are int64; stored as text to avoid precision loss. */
    externalId: text('external_id').notNull(),
    start: timestamp('start', { withTimezone: true }).notNull(),
    end: timestamp('end', { withTimezone: true }),
    timezoneOffset: text('timezone_offset'),
    scoreState: text('score_state'),
    strain: real('strain'),
    averageHeartRate: real('average_heart_rate'),
    maxHeartRate: real('max_heart_rate'),
    kilojoule: real('kilojoule'),
    raw: jsonb('raw').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex('whoop_cycles_external_unique').on(t.connectionId, t.externalId),
    index('whoop_cycles_athlete_start').on(t.athleteId, t.start),
  ],
);

export const whoopRecoveries = pgTable(
  'whoop_recoveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => providerConnections.id, { onDelete: 'cascade' }),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    /** Recovery is keyed by its cycle in WHOOP v2. */
    cycleExternalId: text('cycle_external_id').notNull(),
    sleepExternalId: text('sleep_external_id'),
    localDate: date('local_date').notNull(),
    scoreState: text('score_state'),
    recoveryScore: real('recovery_score'),
    restingHeartRate: real('resting_heart_rate'),
    hrvRmssdMilli: real('hrv_rmssd_milli'),
    spo2Percentage: real('spo2_percentage'),
    skinTempCelsius: real('skin_temp_celsius'),
    userCalibrating: boolean('user_calibrating'),
    raw: jsonb('raw').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex('whoop_recoveries_external_unique').on(t.connectionId, t.cycleExternalId),
    index('whoop_recoveries_athlete_date').on(t.athleteId, t.localDate),
  ],
);

export const whoopSleep = pgTable(
  'whoop_sleep',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => providerConnections.id, { onDelete: 'cascade' }),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    /** WHOOP v2 sleep ids are UUIDs (v1 used int64). */
    externalId: text('external_id').notNull(),
    cycleExternalId: text('cycle_external_id'),
    localDate: date('local_date').notNull(),
    start: timestamp('start', { withTimezone: true }).notNull(),
    end: timestamp('end', { withTimezone: true }).notNull(),
    timezoneOffset: text('timezone_offset'),
    nap: boolean('nap').notNull().default(false),
    scoreState: text('score_state'),
    totalInBedTimeMilli: integer('total_in_bed_time_milli'),
    totalAwakeTimeMilli: integer('total_awake_time_milli'),
    totalLightSleepTimeMilli: integer('total_light_sleep_time_milli'),
    totalSlowWaveSleepTimeMilli: integer('total_slow_wave_sleep_time_milli'),
    totalRemSleepTimeMilli: integer('total_rem_sleep_time_milli'),
    sleepCycleCount: integer('sleep_cycle_count'),
    disturbanceCount: integer('disturbance_count'),
    sleepPerformancePercentage: real('sleep_performance_percentage'),
    sleepConsistencyPercentage: real('sleep_consistency_percentage'),
    sleepEfficiencyPercentage: real('sleep_efficiency_percentage'),
    respiratoryRate: real('respiratory_rate'),
    sleepNeededBaselineMilli: integer('sleep_needed_baseline_milli'),
    raw: jsonb('raw').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex('whoop_sleep_external_unique').on(t.connectionId, t.externalId),
    index('whoop_sleep_athlete_date').on(t.athleteId, t.localDate),
  ],
);

export const whoopWorkouts = pgTable(
  'whoop_workouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => providerConnections.id, { onDelete: 'cascade' }),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    start: timestamp('start', { withTimezone: true }).notNull(),
    end: timestamp('end', { withTimezone: true }).notNull(),
    timezoneOffset: text('timezone_offset'),
    sportName: text('sport_name'),
    sportId: integer('sport_id'),
    scoreState: text('score_state'),
    strain: real('strain'),
    averageHeartRate: real('average_heart_rate'),
    maxHeartRate: real('max_heart_rate'),
    kilojoule: real('kilojoule'),
    distanceMeter: doublePrecision('distance_meter'),
    altitudeGainMeter: doublePrecision('altitude_gain_meter'),
    percentRecorded: real('percent_recorded'),
    zoneDurations: jsonb('zone_durations'),
    raw: jsonb('raw').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex('whoop_workouts_external_unique').on(t.connectionId, t.externalId),
    index('whoop_workouts_athlete_start').on(t.athleteId, t.start),
  ],
);

/**
 * HealthKit samples pushed up from the device.
 *
 * HealthKit is device-local: there is no server API to pull from, so the
 * mobile app reads via the native module and posts normalised samples here.
 * `externalId` is the HKSample UUID, which is stable per device.
 */
export const healthkitSamples = pgTable(
  'healthkit_samples',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => providerConnections.id, { onDelete: 'cascade' }),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    sampleType: text('sample_type').notNull(), // workout | heart_rate | body_mass | ...
    startDate: timestamp('start_date', { withTimezone: true }).notNull(),
    endDate: timestamp('end_date', { withTimezone: true }),
    value: doublePrecision('value'),
    unit: text('unit'),
    payload: jsonb('payload').notNull(),
    sourceName: text('source_name'),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt,
  },
  (t) => [
    uniqueIndex('healthkit_samples_external_unique').on(t.connectionId, t.externalId),
    index('healthkit_samples_athlete_type_start').on(t.athleteId, t.sampleType, t.startDate),
  ],
);

// ---------------------------------------------------------------------------
// Canonical workouts
// ---------------------------------------------------------------------------

export const canonicalWorkouts = pgTable(
  'canonical_workouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    sport: text('sport').notNull().default('run'),
    name: text('name'),
    startTime: timestamp('start_time', { withTimezone: true }).notNull(),
    endTime: timestamp('end_time', { withTimezone: true }).notNull(),
    timezone: text('timezone').notNull(),
    /** Training day in the athlete's local calendar. */
    localDate: date('local_date').notNull(),
    durationSeconds: integer('duration_seconds'),
    movingTimeSeconds: integer('moving_time_seconds'),
    distanceMeters: doublePrecision('distance_meters'),
    avgHeartRateBpm: real('avg_heart_rate_bpm'),
    maxHeartRateBpm: real('max_heart_rate_bpm'),
    avgPaceSecondsPerKm: real('avg_pace_seconds_per_km'),
    elevationGainMeters: doublePrecision('elevation_gain_meters'),
    avgCadenceSpm: real('avg_cadence_spm'),
    avgPowerWatts: real('avg_power_watts'),
    calories: real('calories'),
    perceivedExertion: integer('perceived_exertion'),
    trainingLoad: real('training_load'),
    loadModel: text('load_model'),
    indoor: boolean('indoor'),
    temperatureCelsius: real('temperature_celsius'),
    splits: jsonb('splits'),
    samples: jsonb('samples'),
    route: jsonb('route'),
    sourceConfidence: real('source_confidence').notNull().default(0.5),
    plannedWorkoutId: uuid('planned_workout_id'),
    analysis: jsonb('analysis'),
    createdAt,
    updatedAt,
  },
  (t) => [
    index('canonical_workouts_athlete_date').on(t.athleteId, t.localDate),
    index('canonical_workouts_athlete_start').on(t.athleteId, t.startTime),
  ],
);

/**
 * Join table recording which provider rows fed each canonical workout.
 * This is what makes "where did this number come from?" answerable.
 */
export const workoutSources = pgTable(
  'workout_sources',
  {
    canonicalWorkoutId: uuid('canonical_workout_id')
      .notNull()
      .references(() => canonicalWorkouts.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    contributedFields: jsonb('contributed_fields').notNull().default([]),
    createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.canonicalWorkoutId, t.provider, t.externalId] }),
    // A provider record belongs to exactly one canonical workout.
    uniqueIndex('workout_sources_provider_external_unique').on(t.provider, t.externalId),
  ],
);

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export const trainingPlans = pgTable(
  'training_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    template: text('template').notNull(),
    status: text('status').notNull().default('active'),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    raceGoalId: uuid('race_goal_id'),
    generationBasis: jsonb('generation_basis').notNull().default({}),
    createdAt,
    updatedAt,
  },
  (t) => [index('training_plans_athlete_status').on(t.athleteId, t.status)],
);

export const trainingBlocks = pgTable(
  'training_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => trainingPlans.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    name: text('name').notNull(),
    goal: text('goal').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    durationWeeks: integer('duration_weeks').notNull(),
    orderIndex: integer('order_index').notNull(),
    weeklyDistanceTargetsMeters: jsonb('weekly_distance_targets_meters').notNull().default([]),
    createdAt,
  },
  (t) => [index('training_blocks_plan_order').on(t.planId, t.orderIndex)],
);

export const plannedWorkouts = pgTable(
  'planned_workouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => trainingPlans.id, { onDelete: 'cascade' }),
    blockId: uuid('block_id')
      .notNull()
      .references(() => trainingBlocks.id, { onDelete: 'cascade' }),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    type: text('type').notNull(),
    title: text('title').notNull(),
    purpose: text('purpose').notNull(),
    targetDistanceMeters: doublePrecision('target_distance_meters'),
    targetDurationSeconds: integer('target_duration_seconds'),
    targetRpe: integer('target_rpe'),
    structure: jsonb('structure'),
    status: text('status').notNull().default('planned'),
    modifiedFrom: jsonb('modified_from'),
    completedWorkoutId: uuid('completed_workout_id'),
    createdAt,
    updatedAt,
  },
  (t) => [index('planned_workouts_athlete_date').on(t.athleteId, t.date)],
);

export const raceGoals = pgTable(
  'race_goals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    date: date('date').notNull(),
    distanceMeters: doublePrecision('distance_meters').notNull(),
    targetDurationSeconds: integer('target_duration_seconds'),
    priority: text('priority').notNull().default('A'),
    status: text('status').notNull().default('upcoming'),
    notes: text('notes'),
    resultDurationSeconds: integer('result_duration_seconds'),
    createdAt,
    updatedAt,
  },
  (t) => [index('race_goals_athlete_date').on(t.athleteId, t.date)],
);

/** Race results and time trials used as fitness anchors. */
export const raceResults = pgTable(
  'race_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    distanceMeters: doublePrecision('distance_meters').notNull(),
    durationSeconds: integer('duration_seconds').notNull(),
    date: date('date').notNull(),
    source: text('source').notNull(),
    name: text('name'),
    createdAt,
  },
  (t) => [index('race_results_athlete_date').on(t.athleteId, t.date)],
);

// ---------------------------------------------------------------------------
// Derived daily state
// ---------------------------------------------------------------------------

export const checkIns = pgTable(
  'check_ins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    energy: integer('energy').notNull(),
    soreness: integer('soreness').notNull(),
    stress: integer('stress').notNull(),
    motivation: integer('motivation').notNull(),
    hasPain: boolean('has_pain').notNull().default(false),
    painNote: text('pain_note'),
    createdAt,
  },
  (t) => [uniqueIndex('check_ins_athlete_date_unique').on(t.athleteId, t.date)],
);

export const recoveryStates = pgTable(
  'recovery_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    score: real('score').notNull(),
    band: text('band').notNull(),
    components: jsonb('components').notNull().default([]),
    missingSignals: jsonb('missing_signals').notNull().default([]),
    dataCompleteness: real('data_completeness').notNull().default(0),
    summary: text('summary').notNull().default(''),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('recovery_states_athlete_date_unique').on(t.athleteId, t.date)],
);

export const trainingLoads = pgTable(
  'training_loads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    dailyLoad: real('daily_load').notNull().default(0),
    acuteLoad: real('acute_load'),
    chronicLoad: real('chronic_load'),
    acuteChronicRatio: real('acute_chronic_ratio'),
    monotony: real('monotony'),
    strain: real('strain'),
    weeklyLoad: real('weekly_load'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('training_loads_athlete_date_unique').on(t.athleteId, t.date)],
);

export const coachDecisions = pgTable(
  'coach_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    decision: text('decision').notNull(),
    confidence: real('confidence').notNull(),
    reasons: jsonb('reasons').notNull().default([]),
    headline: text('headline').notNull(),
    explanation: text('explanation').notNull(),
    affectedWorkoutId: uuid('affected_workout_id'),
    previousPlan: jsonb('previous_plan'),
    recommendedPlan: jsonb('recommended_plan'),
    /** True once the athlete has seen it, for notification suppression. */
    acknowledged: boolean('acknowledged').notNull().default(false),
    createdAt,
  },
  (t) => [uniqueIndex('coach_decisions_athlete_date_unique').on(t.athleteId, t.date)],
);

export const coachInsights = pgTable(
  'coach_insights',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    dataPoints: jsonb('data_points').notNull().default([]),
    severity: text('severity').notNull().default('info'),
    createdAt,
  },
  (t) => [index('coach_insights_athlete_created').on(t.athleteId, t.createdAt)],
);

/**
 * Durable athlete preferences and observed patterns the coach remembers.
 * `kind` separates a stated preference from an inferred pattern — conflating
 * the two is how an assistant ends up confidently wrong about someone.
 */
export const coachMemory = pgTable(
  'coach_memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // stated_preference | observed_pattern | temporary_condition
    key: text('key').notNull(),
    value: text('value').notNull(),
    /** How many observations support this, for inferred patterns. */
    observationCount: integer('observation_count').notNull().default(1),
    confidence: real('confidence').notNull().default(0.5),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [uniqueIndex('coach_memory_unique').on(t.athleteId, t.kind, t.key)],
);

export const coachConversations = pgTable(
  'coach_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // user | assistant
    content: text('content').notNull(),
    structured: jsonb('structured'),
    createdAt,
  },
  (t) => [index('coach_conversations_athlete_created').on(t.athleteId, t.createdAt)],
);

export const weeklySummaries = pgTable(
  'weekly_summaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    weekStart: date('week_start').notNull(),
    weekKey: text('week_key').notNull(),
    payload: jsonb('payload').notNull(),
    review: jsonb('review'),
    createdAt,
    updatedAt,
  },
  (t) => [uniqueIndex('weekly_summaries_unique').on(t.athleteId, t.weekStart)],
);

// ---------------------------------------------------------------------------
// Body composition
// ---------------------------------------------------------------------------

/**
 * A body composition session: one documentation moment.
 *
 * The athlete stands in the same spot, takes their four photos, and runs a tape
 * round each measure point. Everything recorded in that sitting hangs off one
 * session row, because a later session is compared against the whole set rather
 * than against individual readings.
 *
 * `capturedAt` is the instant; `localDate` is the calendar day in the athlete's
 * timezone. Both are kept for the reason stated at the top of this file — "was
 * this the September session?" is a local-calendar question, and deriving it
 * from a UTC instant at read time gets it wrong either side of midnight.
 *
 * Deliberately not unique per day. An athlete who takes a bad set of photos in
 * the morning and redoes them properly that evening has two sessions, and the
 * database is the wrong place to argue with them about it.
 */
export const bodyCompositionSessions = pgTable(
  'body_composition_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    localDate: date('local_date').notNull(),
    note: text('note'),
    createdAt,
    updatedAt,
  },
  (t) => [
    // History is always read newest-first for one athlete.
    index('body_composition_sessions_athlete_captured').on(t.athleteId, t.capturedAt),
  ],
);

/**
 * One body photo, per side, per session.
 *
 * Unique on (session, side): a session holds at most one front, one back, one
 * left and one right. "Retake one side" is a replacement, not a second front
 * photo — and if two ever coexisted, the before/after comparison would have to
 * guess which one the athlete meant. The database settles it instead.
 *
 * Only the storage key is kept, never a client-supplied URI. The server owns
 * where these live and mints access to them; trusting a path from the device
 * would let one athlete's session reference another's file.
 *
 * `onDelete: 'cascade'` is the whole privacy story for photos: deleting a
 * session, or an account, takes its rows with it in one statement rather than
 * relying on cleanup code that might not run.
 */
export const compositionPhotos = pgTable(
  'composition_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => bodyCompositionSessions.id, { onDelete: 'cascade' }),
    side: text('side').notNull(), // front | back | left | right
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex('composition_photos_session_side_unique').on(t.sessionId, t.side),
    // Deleting a storage object needs to find its row from the key alone.
    uniqueIndex('composition_photos_storage_key_unique').on(t.storageKey),
  ],
);

/**
 * Measure points available for circumference recording.
 *
 * Reference data, not athlete data: the rows are seeded by migration and are
 * the same for everyone. A table rather than a constant so the guide text can
 * be corrected, and a point added, without shipping a new client build —
 * the app renders whatever the server lists.
 *
 * `code` is the stable identifier the client and any future import path key
 * on; the uuid is an implementation detail that must never appear in a URL an
 * athlete could bookmark across environments.
 */
export const circumferencePoints = pgTable(
  'circumference_points',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(), // waist | chest | left_arm | ...
    label: text('label').notNull(),
    guideText: text('guide_text').notNull(),
    sortOrder: integer('sort_order').notNull(),
    /** Retired points stay for the measurements that reference them. */
    isActive: boolean('is_active').notNull().default(true),
    createdAt,
    updatedAt,
  },
  (t) => [uniqueIndex('circumference_points_code_unique').on(t.code)],
);

/**
 * One circumference recorded in one session.
 *
 * Named `composition_measurements`, not `body_measurements` as the PRD has it:
 * that name is already taken above by provider-sourced weight, height and
 * heart-rate observations. Two different things called the same thing is how a
 * query ends up joining an athlete's waist against their resting heart rate.
 *
 * `value_cm` is canonical centimetres, matching the way distance is always
 * metres. `recorded_unit` remembers what the athlete actually read off the
 * tape, which is what lets the app re-display a measurement honestly after they
 * switch their default — a waist taken as 34 in shows as 34.0 in, not as the
 * 86.36 cm a naive round-trip would produce.
 *
 * Unique on (session, point): a session holds at most one value per point.
 * Re-measuring after the tape slipped replaces the earlier number. Two waist
 * values in one session would leave the comparison view and the body-fat
 * formula guessing which one the athlete meant, and the honest answer is always
 * the one they took last.
 */
export const compositionMeasurements = pgTable(
  'composition_measurements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => bodyCompositionSessions.id, { onDelete: 'cascade' }),
    pointId: uuid('point_id')
      .notNull()
      // Restrict, not cascade: retiring a measure point must never silently
      // delete the history an athlete recorded against it.
      .references(() => circumferencePoints.id, { onDelete: 'restrict' }),
    valueCm: doublePrecision('value_cm').notNull(),
    recordedUnit: text('recorded_unit').notNull().default('cm'), // cm | in
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex('composition_measurements_session_point_unique').on(t.sessionId, t.pointId),
    // "This point over time" is the history screen's only query.
    index('composition_measurements_point_captured').on(t.pointId, t.capturedAt),
  ],
);

/**
 * A body fat estimate for one session.
 *
 * Stored as a band, never a figure. Every method available is an estimate built
 * from proxies — a tape and population-fitted coefficients, or a photograph —
 * and none of them measures body fat. There is deliberately no `value` column
 * for a reader to latch onto: a single number with one decimal reads as a
 * measurement, gets written into a training log, and gets compared week to week
 * as though the difference meant something.
 *
 * Unique on (session, method): one formula result and one photo result per
 * session. Re-running the formula on unchanged inputs gives the same answer, and
 * re-reading the same photographs is out of scope — so a second row for the same
 * method would be either a duplicate or noise presented as new information.
 *
 * `service_status` is meaningful only for the AI method and records what the
 * vision service did, which is what lets the app explain an absent result
 * instead of showing a blank.
 */
export const bodyFatEstimates = pgTable(
  'body_fat_estimates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => bodyCompositionSessions.id, { onDelete: 'cascade' }),
    method: text('method').notNull(), // formula | ai
    /** Lower bound, percent. */
    valueLow: doublePrecision('value_low').notNull(),
    /** Upper bound, percent. */
    valueHigh: doublePrecision('value_high').notNull(),
    confidenceLabel: text('confidence_label').notNull(), // low | moderate | high
    /** Only set for the AI method. active | unavailable | failed */
    serviceStatus: text('service_status'),
    /** One sentence on what the result rests on, shown to the athlete. */
    basis: text('basis').notNull().default(''),
    /**
     * The inputs and steps that produced a formula result.
     *
     * Kept so the athlete can inspect a stored estimate months later without
     * the app re-deriving it from measurements that may since have been
     * corrected — the explanation has to match the number it explains.
     */
    calculation: jsonb('calculation'),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex('body_fat_estimates_session_method_unique').on(t.sessionId, t.method),
    index('body_fat_estimates_session').on(t.sessionId),
  ],
);

// ---------------------------------------------------------------------------
// Sync and observability
// ---------------------------------------------------------------------------

export const syncJobs = pgTable(
  'sync_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    athleteId: uuid('athlete_id')
      .notNull()
      .references(() => athleteProfiles.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    kind: text('kind').notNull(), // full | incremental | webhook
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    /** Next attempt time, used for exponential backoff. */
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb('payload'),
    recordsFetched: integer('records_fetched').notNull().default(0),
    recordsCreated: integer('records_created').notNull().default(0),
    recordsUpdated: integer('records_updated').notNull().default(0),
    duplicatesMerged: integer('duplicates_merged').notNull().default(0),
    errors: jsonb('errors').notNull().default([]),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [index('sync_jobs_status_run_after').on(t.status, t.runAfter)],
);

/**
 * Inbound webhook events.
 *
 * Persisted before processing and deduplicated on the provider's own event
 * identity, so a redelivered webhook is acknowledged but not reprocessed.
 */
export const syncEvents = pgTable(
  'sync_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    /** Stable identity derived from the payload for idempotency. */
    eventKey: text('event_key').notNull(),
    externalUserId: text('external_user_id'),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('received'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sync_events_provider_key_unique').on(t.provider, t.eventKey),
    index('sync_events_status').on(t.status),
  ],
);

/**
 * Audit log for security-relevant and data-lifecycle actions.
 * Never contains tokens or raw health values — only what happened, to whom.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id'),
    athleteId: uuid('athlete_id'),
    action: text('action').notNull(),
    resource: text('resource'),
    metadata: jsonb('metadata'),
    ipAddress: text('ip_address'),
    createdAt,
  },
  (t) => [index('audit_logs_user_created').on(t.userId, t.createdAt)],
);

export const schema = {
  users,
  athleteProfiles,
  bodyMeasurements,
  providerConnections,
  stravaActivities,
  whoopCycles,
  whoopRecoveries,
  whoopSleep,
  whoopWorkouts,
  healthkitSamples,
  canonicalWorkouts,
  workoutSources,
  trainingPlans,
  trainingBlocks,
  plannedWorkouts,
  raceGoals,
  raceResults,
  checkIns,
  recoveryStates,
  trainingLoads,
  coachDecisions,
  coachInsights,
  coachMemory,
  coachConversations,
  weeklySummaries,
  bodyCompositionSessions,
  compositionPhotos,
  circumferencePoints,
  compositionMeasurements,
  bodyFatEstimates,
  syncJobs,
  syncEvents,
  auditLogs,
};
