/**
 * Strava API surface constants.
 *
 * All endpoint and scope strings live here so there is exactly one place to
 * check against the official docs (https://developers.strava.com/docs/).
 *
 * Verified against Strava's published behaviour as of August 2026.
 *
 * IMPORTANT — deauthorization endpoint change
 * -------------------------------------------
 * As of 1 June 2026 Strava's recommended deauthorization endpoint is
 * `POST /oauth/revoke`. The legacy `POST /oauth/deauthorize` is deprecated and
 * is scheduled to stop working on 1 June 2027. We call `/oauth/revoke` first
 * and fall back to the legacy endpoint only if it is rejected, so the
 * integration keeps working across the transition in both directions.
 */

export const STRAVA_AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize';
/** Mobile deep-link variant that opens the Strava app when installed. */
export const STRAVA_MOBILE_AUTHORIZE_URL = 'https://www.strava.com/oauth/mobile/authorize';
export const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
export const STRAVA_REVOKE_URL = 'https://www.strava.com/oauth/revoke';
/** Deprecated; retained only as a fallback until 2027-06-01. */
export const STRAVA_LEGACY_DEAUTHORIZE_URL = 'https://www.strava.com/oauth/deauthorize';

export const STRAVA_API_BASE = 'https://www.strava.com/api/v3';
export const STRAVA_WEBHOOK_SUBSCRIPTION_URL = `${STRAVA_API_BASE}/push_subscriptions`;

/**
 * Scopes we request.
 *
 * `activity:read_all` is required to see activities the athlete has marked
 * private or "followers only". Without it a private long run silently vanishes
 * from their training history, which corrupts every volume and load figure.
 * We do NOT request any write scope: this app never modifies Strava data.
 */
export const STRAVA_SCOPES = ['read', 'activity:read_all', 'profile:read_all'] as const;

export const STRAVA_DATA_DESCRIPTION = [
  'Your activities, including private ones',
  'Distance, pace, elevation and heart rate',
  'Route maps and lap splits',
  'Basic profile details',
] as const;

/**
 * Strava sport types that count as running for our purposes.
 * `sport_type` is the modern field; `type` is legacy and less specific.
 */
export const STRAVA_RUN_SPORT_TYPES = new Set([
  'Run',
  'TrailRun',
  'VirtualRun',
  'Treadmill',
]);

export interface StravaTokenResponse {
  token_type: string;
  access_token: string;
  refresh_token: string;
  /** Seconds since epoch when the access token expires. */
  expires_at: number;
  expires_in: number;
  /** Present on the initial exchange only. */
  athlete?: { id: number; firstname?: string; lastname?: string };
  /** Space-delimited granted scopes. */
  scope?: string;
}

export interface StravaActivity {
  id: number;
  name?: string;
  distance?: number;
  moving_time?: number;
  elapsed_time?: number;
  total_elevation_gain?: number;
  type?: string;
  sport_type?: string;
  start_date: string;
  start_date_local?: string;
  timezone?: string;
  average_speed?: number;
  max_speed?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  has_heartrate?: boolean;
  average_cadence?: number;
  average_watts?: number;
  calories?: number;
  suffer_score?: number;
  trainer?: boolean;
  manual?: boolean;
  map?: { summary_polyline?: string; polyline?: string };
  splits_metric?: {
    distance: number;
    elapsed_time: number;
    moving_time: number;
    average_heartrate?: number;
    elevation_difference?: number;
    split: number;
  }[];
  athlete?: { id: number };
}

/**
 * Webhook event payload.
 * `object_type: 'athlete'` with `updates.authorized === 'false'` is the
 * deauthorization signal — the athlete revoked access from Strava's side.
 */
export interface StravaWebhookEvent {
  object_type: 'activity' | 'athlete';
  object_id: number;
  aspect_type: 'create' | 'update' | 'delete';
  owner_id: number;
  subscription_id: number;
  /** Seconds since epoch. */
  event_time: number;
  updates?: Record<string, string>;
}

/**
 * Strava enforces both a short-window and a daily limit, and returns the
 * current usage in response headers. We read them to back off proactively
 * rather than waiting to be rejected.
 */
export interface StravaRateLimitStatus {
  shortTermUsage?: number;
  shortTermLimit?: number;
  dailyUsage?: number;
  dailyLimit?: number;
}

export function parseRateLimitHeaders(headers: Headers): StravaRateLimitStatus {
  const parsePair = (value: string | null): [number, number] | undefined => {
    if (!value) return undefined;
    const [a, b] = value.split(',').map((v) => Number.parseInt(v.trim(), 10));
    if (a === undefined || b === undefined || Number.isNaN(a) || Number.isNaN(b)) return undefined;
    return [a, b];
  };

  const usage = parsePair(headers.get('x-ratelimit-usage'));
  const limit = parsePair(headers.get('x-ratelimit-limit'));

  return {
    shortTermUsage: usage?.[0],
    dailyUsage: usage?.[1],
    shortTermLimit: limit?.[0],
    dailyLimit: limit?.[1],
  };
}

/** True when we are close enough to a limit that we should stop paginating. */
export function shouldPauseForRateLimit(status: StravaRateLimitStatus): boolean {
  const shortTermNearLimit =
    status.shortTermUsage !== undefined &&
    status.shortTermLimit !== undefined &&
    status.shortTermUsage >= status.shortTermLimit * 0.9;

  const dailyNearLimit =
    status.dailyUsage !== undefined &&
    status.dailyLimit !== undefined &&
    status.dailyUsage >= status.dailyLimit * 0.95;

  return shortTermNearLimit || dailyNearLimit;
}
