/**
 * WHOOP v2 → canonical normalisation.
 *
 * The recurring hazard here is `score_state`. A record can exist with
 * `PENDING_SCORE` (WHOOP hasn't finished processing) or `UNSCORABLE` (not
 * enough sensor data), and in both cases the `score` object is absent
 * entirely. Every accessor below treats the score as optional; a pending
 * record is stored so we know it exists, and is filled in when the webhook
 * for the scored version arrives.
 */

import type { ProviderWorkout, SportType, WorkoutType } from '@running/core';
import type {
  NormalizedRecovery,
  NormalizedSleep,
  NormalizedBodyMeasurement,
} from '../types.js';
import {
  WHOOP_RUN_SPORT_NAMES,
  type WhoopBodyMeasurement,
  type WhoopRecovery,
  type WhoopSleep,
  type WhoopWorkout,
} from './api.js';

/**
 * Resolve the local calendar date for a WHOOP record.
 *
 * WHOOP supplies `timezone_offset` as a string like "+07:00" rather than an
 * IANA zone, so we shift the instant by the offset and read the UTC date of
 * the result. That yields the athlete's local day without needing the zone.
 */
export function localDateFromOffset(instant: string, timezoneOffset: string | undefined): string {
  const date = new Date(instant);
  if (!timezoneOffset) return date.toISOString().slice(0, 10);

  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(timezoneOffset.trim());
  if (!match) return date.toISOString().slice(0, 10);

  const [, sign, hours, minutes] = match as unknown as [string, string, string, string];
  const offsetMinutes =
    (sign === '-' ? -1 : 1) * (Number.parseInt(hours, 10) * 60 + Number.parseInt(minutes, 10));

  return new Date(date.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function toSportType(sportName: string | undefined): SportType {
  const name = (sportName ?? '').toLowerCase();
  if (WHOOP_RUN_SPORT_NAMES.has(name) || name.includes('run')) return 'run';
  if (name.includes('walk') || name.includes('hik')) return 'walk';
  if (name.includes('cycl') || name.includes('bik')) return 'ride';
  if (name.includes('swim')) return 'swim';
  if (name.includes('weight') || name.includes('strength')) return 'strength';
  return 'other';
}

function toWorkoutType(sport: SportType): WorkoutType {
  switch (sport) {
    case 'run':
      // WHOOP auto-detection can't distinguish an interval session from an
      // easy run, so we stay conservative and let Strava's naming (or the
      // athlete) supply the specific type during the merge.
      return 'easy';
    case 'walk':
      return 'recovery';
    case 'strength':
      return 'strength';
    default:
      return 'cross_training';
  }
}

export function toProviderWorkout(
  workout: WhoopWorkout,
  args: { athleteId: string; defaultTimezone: string; syncedAt?: Date },
): ProviderWorkout {
  const sport = toSportType(workout.sport_name);
  const start = new Date(workout.start);
  const end = new Date(workout.end);
  const score = workout.score;

  return {
    provider: 'whoop',
    externalId: workout.id,
    athleteId: args.athleteId,
    type: toWorkoutType(sport),
    sport,
    name: workout.sport_name,
    startTime: start,
    endTime: end,
    timezone: args.defaultTimezone,
    durationSeconds: Math.round((end.getTime() - start.getTime()) / 1000),
    distanceMeters: score?.distance_meter,
    avgHeartRateBpm: score?.average_heart_rate,
    maxHeartRateBpm: score?.max_heart_rate,
    elevationGainMeters: score?.altitude_gain_meter,
    // WHOOP reports energy in kilojoules; kcal = kJ / 4.184.
    calories: score?.kilojoule !== undefined ? score.kilojoule / 4.184 : undefined,
    syncedAt: args.syncedAt ?? new Date(),
  };
}

export function toNormalizedRecovery(recovery: WhoopRecovery): NormalizedRecovery {
  const score = recovery.score;
  return {
    // Recovery has no id of its own in v2; it is keyed by its cycle.
    externalId: String(recovery.cycle_id),
    localDate: recovery.created_at.slice(0, 10),
    recoveryScore: score?.recovery_score,
    hrvRmssdMs: score?.hrv_rmssd_milli,
    restingHeartRateBpm: score?.resting_heart_rate,
    spo2Percent: score?.spo2_percentage,
    skinTempCelsius: score?.skin_temp_celsius,
    calibrating: score?.user_calibrating,
    raw: recovery,
  };
}

export function toNormalizedSleep(sleep: WhoopSleep): NormalizedSleep {
  const summary = sleep.score?.stage_summary;

  // Total sleep excludes time awake and time with no data.
  const totalSleepMilli = summary
    ? summary.total_light_sleep_time_milli +
      summary.total_slow_wave_sleep_time_milli +
      summary.total_rem_sleep_time_milli
    : new Date(sleep.end).getTime() - new Date(sleep.start).getTime();

  return {
    externalId: sleep.id,
    // Sleep is attributed to the day it ended, which is the morning the
    // athlete wakes into — that's the day the recovery applies to.
    localDate: localDateFromOffset(sleep.end, sleep.timezone_offset),
    start: new Date(sleep.start),
    end: new Date(sleep.end),
    totalSleepSeconds: Math.round(totalSleepMilli / 1000),
    timeInBedSeconds: summary ? Math.round(summary.total_in_bed_time_milli / 1000) : undefined,
    lightSleepSeconds: summary
      ? Math.round(summary.total_light_sleep_time_milli / 1000)
      : undefined,
    deepSleepSeconds: summary
      ? Math.round(summary.total_slow_wave_sleep_time_milli / 1000)
      : undefined,
    remSleepSeconds: summary ? Math.round(summary.total_rem_sleep_time_milli / 1000) : undefined,
    awakeSeconds: summary ? Math.round(summary.total_awake_time_milli / 1000) : undefined,
    performancePercent: sleep.score?.sleep_performance_percentage,
    consistencyPercent: sleep.score?.sleep_consistency_percentage,
    efficiencyPercent: sleep.score?.sleep_efficiency_percentage,
    respiratoryRate: sleep.score?.respiratory_rate,
    disturbanceCount: summary?.disturbance_count,
    isNap: sleep.nap,
    raw: sleep,
  };
}

export function toBodyMeasurements(
  body: WhoopBodyMeasurement,
  measuredAt: Date,
): NormalizedBodyMeasurement[] {
  const out: NormalizedBodyMeasurement[] = [];

  if (body.weight_kilogram > 0) {
    out.push({
      metric: 'weight_kg',
      originalValue: body.weight_kilogram,
      normalizedValue: body.weight_kilogram,
      measuredAt,
    });
  }
  if (body.height_meter > 0) {
    out.push({
      metric: 'height_m',
      originalValue: body.height_meter,
      normalizedValue: body.height_meter,
      measuredAt,
    });
  }
  if (body.max_heart_rate > 0) {
    out.push({
      metric: 'max_hr',
      originalValue: body.max_heart_rate,
      normalizedValue: body.max_heart_rate,
      measuredAt,
    });
  }

  return out;
}

/** Stable identity for a WHOOP webhook, used to deduplicate redeliveries. */
export function webhookEventKey(event: {
  user_id: number;
  id: string | number;
  type: string;
}): string {
  return `${event.type}:${event.id}:${event.user_id}`;
}
