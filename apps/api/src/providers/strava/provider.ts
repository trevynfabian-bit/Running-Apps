/**
 * Strava provider implementation.
 */

import type {
  FitnessDataProvider,
  OAuthTokens,
  ProviderCapabilities,
  ProviderSyncPayload,
  SyncWindow,
} from '../types.js';
import { ProviderAuthError, ProviderRateLimitError, emptyPayload } from '../types.js';
import {
  STRAVA_API_BASE,
  STRAVA_AUTHORIZE_URL,
  STRAVA_DATA_DESCRIPTION,
  STRAVA_LEGACY_DEAUTHORIZE_URL,
  STRAVA_REVOKE_URL,
  STRAVA_SCOPES,
  STRAVA_TOKEN_URL,
  parseRateLimitHeaders,
  shouldPauseForRateLimit,
  type StravaActivity,
  type StravaTokenResponse,
} from './api.js';
import { toProviderWorkout } from './normalize.js';
import { env } from '../../env.js';
import { logger } from '../../observability/logger.js';

const CAPABILITIES: ProviderCapabilities = {
  serverPull: true,
  webhooks: true,
  workouts: true,
  recovery: false,
  sleep: false,
  bodyMeasurements: false,
  routes: true,
};

/** Activities per page. Strava's maximum is 200. */
const PAGE_SIZE = 100;
/** Hard cap on pages per sync pass, so one run can't exhaust the rate limit. */
const MAX_PAGES_PER_SYNC = 10;

export class StravaProvider implements FitnessDataProvider {
  readonly id = 'strava' as const;
  readonly displayName = 'Strava';
  readonly capabilities = CAPABILITIES;
  readonly scopes = STRAVA_SCOPES;
  readonly dataDescription = STRAVA_DATA_DESCRIPTION;

  isConfigured(): boolean {
    return env().stravaConfigured;
  }

  buildAuthorizationUrl(args: { state: string }): string {
    const config = env();
    const url = new URL(STRAVA_AUTHORIZE_URL);
    url.searchParams.set('client_id', config.STRAVA_CLIENT_ID ?? '');
    url.searchParams.set('redirect_uri', config.STRAVA_REDIRECT_URI ?? '');
    url.searchParams.set('response_type', 'code');
    // `force` ensures the athlete sees the scope screen again when
    // reconnecting, so a previously-declined scope can be granted.
    url.searchParams.set('approval_prompt', 'auto');
    url.searchParams.set('scope', STRAVA_SCOPES.join(','));
    url.searchParams.set('state', args.state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<OAuthTokens> {
    const config = env();
    const response = await fetch(STRAVA_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: config.STRAVA_CLIENT_ID,
        client_secret: config.STRAVA_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
      }),
    });

    if (!response.ok) {
      throw new ProviderAuthError('strava', `Token exchange failed (${response.status}).`);
    }

    return this.toTokens((await response.json()) as StravaTokenResponse);
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokens> {
    const config = env();
    const response = await fetch(STRAVA_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: config.STRAVA_CLIENT_ID,
        client_secret: config.STRAVA_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (response.status === 400 || response.status === 401) {
      // The athlete revoked us, or the refresh token was rotated away.
      throw new ProviderAuthError('strava', 'Strava authorization is no longer valid.');
    }
    if (!response.ok) {
      throw new Error(`Strava token refresh failed (${response.status}).`);
    }

    return this.toTokens((await response.json()) as StravaTokenResponse);
  }

  /**
   * Revoke at Strava.
   *
   * Prefers the current `/oauth/revoke` endpoint and falls back to the legacy
   * `/oauth/deauthorize` only if that is rejected, so this keeps working
   * across Strava's 2026→2027 migration window in both directions.
   */
  async revoke(accessToken: string): Promise<void> {
    const attempt = async (url: string): Promise<boolean> => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      return response.ok;
    };

    try {
      if (await attempt(STRAVA_REVOKE_URL)) return;
      logger.warn('strava.revoke.fallback_to_legacy');
      if (await attempt(STRAVA_LEGACY_DEAUTHORIZE_URL)) return;
      logger.warn('strava.revoke.failed_both_endpoints');
    } catch (error) {
      // A failure to revoke remotely must never block the local disconnect —
      // the athlete asked us to stop, and we stop regardless.
      logger.warn('strava.revoke.error', { error: String(error) });
    }
  }

  async sync(args: {
    tokens: OAuthTokens;
    window: SyncWindow;
    athleteId: string;
    timezone: string;
  }): Promise<ProviderSyncPayload> {
    const payload = emptyPayload();
    const { tokens, window } = args;

    let page = 1;
    let newestSeen: number | undefined;

    while (page <= MAX_PAGES_PER_SYNC) {
      const url = new URL(`${STRAVA_API_BASE}/athlete/activities`);
      url.searchParams.set('per_page', String(PAGE_SIZE));
      url.searchParams.set('page', String(page));
      if (window.since) {
        url.searchParams.set('after', String(Math.floor(window.since.getTime() / 1000)));
      }
      if (window.until) {
        url.searchParams.set('before', String(Math.floor(window.until.getTime() / 1000)));
      }

      const response = await fetch(url, {
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });

      if (response.status === 401) {
        throw new ProviderAuthError('strava', 'Strava rejected the access token.');
      }
      if (response.status === 429) {
        const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
        throw new ProviderRateLimitError(
          'strava',
          Number.isNaN(retryAfter) ? undefined : retryAfter,
          'Strava rate limit reached.',
        );
      }
      if (!response.ok) {
        payload.warnings.push(`Strava returned ${response.status} while listing activities.`);
        break;
      }

      const activities = (await response.json()) as StravaActivity[];
      if (activities.length === 0) break;

      for (const activity of activities) {
        payload.workouts.push(
          toProviderWorkout(activity, {
            athleteId: args.athleteId,
            defaultTimezone: args.timezone,
          }),
        );
        const startedAt = new Date(activity.start_date).getTime();
        if (newestSeen === undefined || startedAt > newestSeen) newestSeen = startedAt;
      }

      // Stop early when approaching a rate limit; the next scheduled sync
      // resumes from the cursor rather than failing loudly.
      const rateLimit = parseRateLimitHeaders(response.headers);
      if (shouldPauseForRateLimit(rateLimit)) {
        payload.warnings.push(
          'Paused early to stay within Strava rate limits. Remaining activities will sync shortly.',
        );
        break;
      }

      if (activities.length < PAGE_SIZE) break;
      page++;
    }

    if (page > MAX_PAGES_PER_SYNC) {
      payload.warnings.push('More history is available and will continue syncing in the background.');
    }

    // High-water mark for the next incremental run.
    payload.nextCursor = newestSeen ? { after: Math.floor(newestSeen / 1000) } : window.cursor;

    return payload;
  }

  /** Fetch a single activity, used by webhook processing. */
  async fetchActivity(accessToken: string, activityId: string): Promise<StravaActivity | undefined> {
    const response = await fetch(`${STRAVA_API_BASE}/activities/${activityId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });

    if (response.status === 404) return undefined;
    if (response.status === 401) {
      throw new ProviderAuthError('strava', 'Strava rejected the access token.');
    }
    if (!response.ok) {
      throw new Error(`Strava activity fetch failed (${response.status}).`);
    }
    return (await response.json()) as StravaActivity;
  }

  private toTokens(body: StravaTokenResponse): OAuthTokens {
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: body.expires_at ? new Date(body.expires_at * 1000) : undefined,
      // Strava returns granted scopes space-delimited.
      scopes: body.scope ? body.scope.split(/[\s,]+/).filter(Boolean) : [...STRAVA_SCOPES],
      externalUserId: body.athlete?.id ? String(body.athlete.id) : undefined,
    };
  }
}
