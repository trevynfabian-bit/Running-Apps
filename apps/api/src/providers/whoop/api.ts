/**
 * WHOOP API surface constants.
 *
 * Every value here was taken from WHOOP's published OpenAPI document
 * (https://api.prod.whoop.com/developer/doc/openapi.json), a snapshot of which
 * is committed at docs/whoop-openapi-v2.snapshot.json for reference.
 *
 * This is the **v2** API. v2 differs from v1 in ways that matter:
 *   - Sleep and workout ids are UUIDs in v2 (they were int64 in v1). Cycle ids
 *     remain int64, so ids are stored as text throughout to avoid both
 *     precision loss and type confusion.
 *   - Records carry `score_state`, which may be PENDING_SCORE or UNSCORABLE.
 *     A record with a non-SCORED state has no `score` object at all, so every
 *     consumer must tolerate its absence rather than assuming a score exists.
 *   - Pagination is by opaque `nextToken`, not numeric offsets.
 */

export const WHOOP_AUTHORIZE_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
export const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
export const WHOOP_API_BASE = 'https://api.prod.whoop.com/developer';

export const WHOOP_ENDPOINTS = {
  cycles: '/v2/cycle',
  cycleById: (id: string) => `/v2/cycle/${id}`,
  sleepForCycle: (id: string) => `/v2/cycle/${id}/sleep`,
  recoveryForCycle: (id: string) => `/v2/cycle/${id}/recovery`,
  recoveries: '/v2/recovery',
  sleep: '/v2/activity/sleep',
  sleepById: (id: string) => `/v2/activity/sleep/${id}`,
  workouts: '/v2/activity/workout',
  workoutById: (id: string) => `/v2/activity/workout/${id}`,
  profile: '/v2/user/profile/basic',
  bodyMeasurement: '/v2/user/measurement/body',
  /** Revokes this application's access for the authenticated user. */
  revokeAccess: '/v2/user/access',
} as const;

/**
 * Scopes.
 *
 * `offline` is not a data scope — it is what makes WHOOP issue a refresh
 * token. Without it the integration silently stops working when the first
 * access token expires.
 *
 * Note the inconsistent pluralisation in WHOOP's own scope names
 * (`read:cycles` plural, `read:workout` singular). These strings are copied
 * verbatim from the OpenAPI document; do not "correct" them.
 */
export const WHOOP_SCOPES = [
  'read:recovery',
  'read:cycles',
  'read:sleep',
  'read:workout',
  'read:profile',
  'read:body_measurement',
  'offline',
] as const;

export const WHOOP_DATA_DESCRIPTION = [
  'Daily recovery score, HRV and resting heart rate',
  'Sleep duration, stages and performance',
  'Daily strain and physiological cycles',
  'Detected workouts and their strain',
  'Height, weight and max heart rate',
] as const;

export type WhoopScoreState = 'SCORED' | 'PENDING_SCORE' | 'UNSCORABLE';

export interface WhoopPaginated<T> {
  records?: T[];
  next_token?: string;
}

export interface WhoopCycle {
  id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end?: string;
  timezone_offset: string;
  score_state: WhoopScoreState;
  score?: {
    strain: number;
    kilojoule: number;
    average_heart_rate: number;
    max_heart_rate: number;
  };
}

export interface WhoopRecovery {
  cycle_id: number;
  sleep_id: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  score_state: WhoopScoreState;
  score?: {
    user_calibrating: boolean;
    recovery_score: number;
    resting_heart_rate: number;
    hrv_rmssd_milli: number;
    spo2_percentage?: number;
    skin_temp_celsius?: number;
  };
}

export interface WhoopSleep {
  id: string;
  cycle_id: number;
  v1_id?: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  timezone_offset: string;
  nap: boolean;
  score_state: WhoopScoreState;
  score?: {
    stage_summary: {
      total_in_bed_time_milli: number;
      total_awake_time_milli: number;
      total_no_data_time_milli: number;
      total_light_sleep_time_milli: number;
      total_slow_wave_sleep_time_milli: number;
      total_rem_sleep_time_milli: number;
      sleep_cycle_count: number;
      disturbance_count: number;
    };
    sleep_needed: {
      baseline_milli: number;
      need_from_sleep_debt_milli: number;
      need_from_recent_strain_milli: number;
      need_from_recent_nap_milli: number;
    };
    respiratory_rate?: number;
    sleep_performance_percentage?: number;
    sleep_consistency_percentage?: number;
    sleep_efficiency_percentage?: number;
  };
}

export interface WhoopWorkout {
  id: string;
  v1_id?: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  timezone_offset: string;
  sport_name: string;
  sport_id?: number;
  score_state: WhoopScoreState;
  score?: {
    strain: number;
    average_heart_rate: number;
    max_heart_rate: number;
    kilojoule: number;
    percent_recorded: number;
    distance_meter?: number;
    altitude_gain_meter?: number;
    altitude_change_meter?: number;
    zone_durations: {
      zone_zero_milli: number;
      zone_one_milli: number;
      zone_two_milli: number;
      zone_three_milli: number;
      zone_four_milli: number;
      zone_five_milli: number;
    };
  };
}

export interface WhoopBodyMeasurement {
  height_meter: number;
  weight_kilogram: number;
  max_heart_rate: number;
}

export interface WhoopProfile {
  user_id: number;
  email: string;
  first_name: string;
  last_name: string;
}

/** Sport names WHOOP uses for running activity. */
export const WHOOP_RUN_SPORT_NAMES = new Set(['running', 'trail_running', 'treadmill_running']);

export interface WhoopTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

/**
 * Inbound webhook payload.
 *
 * v2 event types are suffixed (`workout.updated`, `sleep.deleted`, ...). The
 * `id` is the affected object's id — a UUID for sleep and workouts, a number
 * for recovery's cycle. We always re-fetch the canonical object rather than
 * trusting anything in the notification body.
 */
export interface WhoopWebhookEvent {
  user_id: number;
  id: string | number;
  type: string;
  trace_id?: string;
}

/** Kind of object a webhook refers to, derived from its event type. */
export function webhookObjectKind(
  type: string,
): 'workout' | 'sleep' | 'recovery' | 'cycle' | 'unknown' {
  const head = type.split('.')[0]?.toLowerCase();
  if (head === 'workout') return 'workout';
  if (head === 'sleep') return 'sleep';
  if (head === 'recovery') return 'recovery';
  if (head === 'cycle') return 'cycle';
  return 'unknown';
}

export function isDeleteEvent(type: string): boolean {
  return type.toLowerCase().endsWith('.deleted');
}
