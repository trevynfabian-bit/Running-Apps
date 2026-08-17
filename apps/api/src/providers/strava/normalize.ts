/**
 * Strava → canonical normalisation.
 *
 * Kept separate from the HTTP client so it can be tested against fixture
 * payloads with no network, and so a normalisation fix can be replayed over
 * the retained raw JSON without re-fetching from Strava.
 */

import type { ProviderWorkout, WorkoutSplit, WorkoutType, SportType, GeoPoint } from '@running/core';
import { STRAVA_RUN_SPORT_TYPES, type StravaActivity } from './api.js';

/**
 * Map a Strava sport type onto our sport bucket.
 * Non-running activity still matters: it contributes to training load and
 * recovery cost even though it never counts toward running volume.
 */
export function toSportType(activity: StravaActivity): SportType {
  const sport = activity.sport_type ?? activity.type ?? '';
  if (STRAVA_RUN_SPORT_TYPES.has(sport)) return 'run';
  if (sport === 'Walk' || sport === 'Hike') return 'walk';
  if (sport.includes('Ride') || sport === 'Velomobile') return 'ride';
  if (sport.includes('Swim')) return 'swim';
  if (sport === 'WeightTraining' || sport === 'Crossfit' || sport === 'Workout') return 'strength';
  return 'other';
}

/**
 * Infer a workout type.
 *
 * Strava has no notion of "this was a threshold session", so we infer from the
 * name the athlete gave it plus its shape. This is a heuristic and is
 * deliberately conservative: mislabelling an easy run as intervals would
 * corrupt intensity distribution, so anything ambiguous stays 'easy'.
 */
export function inferWorkoutType(activity: StravaActivity): WorkoutType {
  const sport = toSportType(activity);
  if (sport === 'ride' || sport === 'swim') return 'cross_training';
  if (sport === 'strength') return 'strength';
  if (sport === 'walk') return 'recovery';

  const name = (activity.name ?? '').toLowerCase();

  // Explicit naming is the strongest signal available.
  if (/\brace\b|\bparkrun\b|\b(5|10)k race\b|marathon/.test(name)) return 'race';
  if (/interval|repeat|\d+\s*[x×]\s*\d+|track/.test(name)) return 'intervals';
  if (/threshold|tempo/.test(name)) return 'threshold';
  if (/hill/.test(name)) return 'hills';
  if (/fartlek/.test(name)) return 'fartlek';
  if (/stride/.test(name)) return 'strides';
  if (/time trial|\btt\b/.test(name)) return 'time_trial';
  if (/recovery|shakeout|easy/.test(name)) return name.includes('recovery') ? 'recovery' : 'easy';
  if (/long/.test(name)) return 'long';
  if (activity.trainer) return 'treadmill';

  // Shape-based fallback: a long continuous run is a long run regardless of
  // what it was called.
  const distance = activity.distance ?? 0;
  if (distance >= 15000) return 'long';

  return 'easy';
}

/** Strava reports splits in metric kilometre laps. */
export function toSplits(activity: StravaActivity): WorkoutSplit[] | undefined {
  if (!activity.splits_metric?.length) return undefined;
  return activity.splits_metric.map((split) => ({
    index: split.split,
    distanceMeters: split.distance,
    durationSeconds: split.moving_time || split.elapsed_time,
    avgHeartRateBpm: split.average_heartrate,
    elevationGainMeters:
      split.elevation_difference !== undefined ? Math.max(0, split.elevation_difference) : undefined,
  }));
}

/**
 * Decode Google's encoded-polyline format, which Strava uses for route maps.
 *
 * Implemented directly rather than pulled in as a dependency: the algorithm is
 * short, stable, and this avoids a transitive package in the ingest path.
 */
export function decodePolyline(encoded: string): GeoPoint[] {
  const points: GeoPoint[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / 1e5, lon: lon / 1e5 });
  }

  return points;
}

/**
 * Convert a Strava activity into the provider-neutral shape the dedup engine
 * consumes.
 */
export function toProviderWorkout(
  activity: StravaActivity,
  args: { athleteId: string; defaultTimezone: string; syncedAt?: Date },
): ProviderWorkout {
  const startTime = new Date(activity.start_date);
  const elapsed = activity.elapsed_time ?? 0;
  const moving = activity.moving_time;

  // Strava's `timezone` looks like "(GMT+07:00) Asia/Jakarta"; we want the
  // IANA portion only.
  const timezone = activity.timezone?.includes(' ')
    ? activity.timezone.split(' ').pop()
    : activity.timezone;

  const polyline = activity.map?.polyline ?? activity.map?.summary_polyline;

  return {
    provider: 'strava',
    externalId: String(activity.id),
    athleteId: args.athleteId,
    type: inferWorkoutType(activity),
    sport: toSportType(activity),
    name: activity.name,
    startTime,
    endTime: new Date(startTime.getTime() + elapsed * 1000),
    timezone: timezone || args.defaultTimezone,
    durationSeconds: elapsed || undefined,
    movingTimeSeconds: moving,
    distanceMeters: activity.distance,
    // `has_heartrate: false` means the figures present are not real HR data.
    avgHeartRateBpm: activity.has_heartrate === false ? undefined : activity.average_heartrate,
    maxHeartRateBpm: activity.has_heartrate === false ? undefined : activity.max_heartrate,
    elevationGainMeters: activity.total_elevation_gain,
    // Strava reports running cadence per leg; double it for steps per minute.
    avgCadenceSpm:
      activity.average_cadence !== undefined && toSportType(activity) === 'run'
        ? activity.average_cadence * 2
        : activity.average_cadence,
    avgPowerWatts: activity.average_watts,
    calories: activity.calories,
    splits: toSplits(activity),
    route: polyline ? decodePolyline(polyline) : undefined,
    indoor: activity.trainer === true,
    syncedAt: args.syncedAt ?? new Date(),
  };
}

/** Stable identity for a webhook event, used to deduplicate redeliveries. */
export function webhookEventKey(event: {
  object_type: string;
  object_id: number;
  aspect_type: string;
  event_time: number;
  owner_id: number;
}): string {
  return `${event.object_type}:${event.object_id}:${event.aspect_type}:${event.event_time}:${event.owner_id}`;
}
