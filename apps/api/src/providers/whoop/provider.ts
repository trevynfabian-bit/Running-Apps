/**
 * WHOOP v2 provider implementation.
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
  WHOOP_API_BASE,
  WHOOP_AUTHORIZE_URL,
  WHOOP_DATA_DESCRIPTION,
  WHOOP_ENDPOINTS,
  WHOOP_SCOPES,
  WHOOP_TOKEN_URL,
  type WhoopBodyMeasurement,
  type WhoopPaginated,
  type WhoopRecovery,
  type WhoopSleep,
  type WhoopTokenResponse,
  type WhoopWorkout,
} from './api.js';
import {
  toBodyMeasurements,
  toNormalizedRecovery,
  toNormalizedSleep,
  toProviderWorkout,
} from './normalize.js';
import { env } from '../../env.js';
import { logger } from '../../observability/logger.js';

const CAPABILITIES: ProviderCapabilities = {
  serverPull: true,
  webhooks: true,
  workouts: true,
  recovery: true,
  sleep: true,
  bodyMeasurements: true,
  routes: false,
};

const PAGE_SIZE = 25;
const MAX_PAGES_PER_COLLECTION = 10;

export class WhoopProvider implements FitnessDataProvider {
  readonly id = 'whoop' as const;
  readonly displayName = 'WHOOP';
  readonly capabilities = CAPABILITIES;
  readonly scopes = WHOOP_SCOPES;
  readonly dataDescription = WHOOP_DATA_DESCRIPTION;

  isConfigured(): boolean {
    return env().whoopConfigured;
  }

  buildAuthorizationUrl(args: { state: string }): string {
    const config = env();
    const url = new URL(WHOOP_AUTHORIZE_URL);
    url.searchParams.set('client_id', config.WHOOP_CLIENT_ID ?? '');
    url.searchParams.set('redirect_uri', config.WHOOP_REDIRECT_URI ?? '');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', WHOOP_SCOPES.join(' '));
    // WHOOP requires the state parameter to be at least 8 characters.
    url.searchParams.set('state', args.state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<OAuthTokens> {
    const config = env();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.WHOOP_CLIENT_ID ?? '',
      client_secret: config.WHOOP_CLIENT_SECRET ?? '',
      redirect_uri: config.WHOOP_REDIRECT_URI ?? '',
    });

    const response = await fetch(WHOOP_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      throw new ProviderAuthError('whoop', `Token exchange failed (${response.status}).`);
    }

    const tokens = this.toTokens((await response.json()) as WhoopTokenResponse);
    // Attach the WHOOP user id so inbound webhooks can be routed to this athlete.
    tokens.externalUserId = await this.fetchUserId(tokens.accessToken);
    return tokens;
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokens> {
    const config = env();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.WHOOP_CLIENT_ID ?? '',
      client_secret: config.WHOOP_CLIENT_SECRET ?? '',
      // WHOOP requires `offline` to be re-requested to keep issuing refresh tokens.
      scope: 'offline',
    });

    const response = await fetch(WHOOP_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (response.status === 400 || response.status === 401) {
      throw new ProviderAuthError('whoop', 'WHOOP authorization is no longer valid.');
    }
    if (!response.ok) {
      throw new Error(`WHOOP token refresh failed (${response.status}).`);
    }

    return this.toTokens((await response.json()) as WhoopTokenResponse);
  }

  async revoke(accessToken: string): Promise<void> {
    try {
      const response = await fetch(`${WHOOP_API_BASE}${WHOOP_ENDPOINTS.revokeAccess}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        logger.warn('whoop.revoke.failed', { status: response.status });
      }
    } catch (error) {
      // Never block the local disconnect on a remote revoke failure.
      logger.warn('whoop.revoke.error', { error: String(error) });
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

    // Workouts
    const workouts = await this.fetchCollection<WhoopWorkout>(
      tokens.accessToken,
      WHOOP_ENDPOINTS.workouts,
      window,
      payload.warnings,
    );
    for (const workout of workouts) {
      payload.workouts.push(
        toProviderWorkout(workout, {
          athleteId: args.athleteId,
          defaultTimezone: args.timezone,
        }),
      );
    }

    // Recovery
    const recoveries = await this.fetchCollection<WhoopRecovery>(
      tokens.accessToken,
      WHOOP_ENDPOINTS.recoveries,
      window,
      payload.warnings,
    );
    payload.recoveries.push(...recoveries.map(toNormalizedRecovery));

    // Sleep
    const sleep = await this.fetchCollection<WhoopSleep>(
      tokens.accessToken,
      WHOOP_ENDPOINTS.sleep,
      window,
      payload.warnings,
    );
    payload.sleep.push(...sleep.map(toNormalizedSleep));

    // Body measurements: a single current snapshot rather than a collection.
    try {
      const body = await this.fetchJson<WhoopBodyMeasurement>(
        tokens.accessToken,
        WHOOP_ENDPOINTS.bodyMeasurement,
      );
      if (body) payload.bodyMeasurements.push(...toBodyMeasurements(body, new Date()));
    } catch (error) {
      payload.warnings.push('Could not read WHOOP body measurements.');
      logger.warn('whoop.body_measurement.failed', { error: String(error) });
    }

    payload.nextCursor = { syncedThrough: new Date().toISOString() };
    return payload;
  }

  /** Fetch one object by id — used by webhook processing. */
  async fetchById<T>(accessToken: string, path: string): Promise<T | undefined> {
    return this.fetchJson<T>(accessToken, path);
  }

  private async fetchUserId(accessToken: string): Promise<string | undefined> {
    try {
      const profile = await this.fetchJson<{ user_id: number }>(
        accessToken,
        WHOOP_ENDPOINTS.profile,
      );
      return profile?.user_id !== undefined ? String(profile.user_id) : undefined;
    } catch {
      // Not fatal: without it, webhooks fall back to matching on connection.
      return undefined;
    }
  }

  private async fetchJson<T>(accessToken: string, path: string): Promise<T | undefined> {
    const response = await fetch(`${WHOOP_API_BASE}${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });

    if (response.status === 404) return undefined;
    if (response.status === 401) {
      throw new ProviderAuthError('whoop', 'WHOOP rejected the access token.');
    }
    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
      throw new ProviderRateLimitError(
        'whoop',
        Number.isNaN(retryAfter) ? undefined : retryAfter,
        'WHOOP rate limit reached.',
      );
    }
    if (!response.ok) throw new Error(`WHOOP request failed (${response.status}) for ${path}.`);

    return (await response.json()) as T;
  }

  /**
   * Page through a v2 collection endpoint.
   * Pagination uses the opaque `nextToken`; there are no numeric offsets.
   */
  private async fetchCollection<T>(
    accessToken: string,
    path: string,
    window: SyncWindow,
    warnings: string[],
  ): Promise<T[]> {
    const out: T[] = [];
    let nextToken: string | undefined;
    let pages = 0;

    do {
      const url = new URL(`${WHOOP_API_BASE}${path}`);
      url.searchParams.set('limit', String(PAGE_SIZE));
      if (window.since) url.searchParams.set('start', window.since.toISOString());
      if (window.until) url.searchParams.set('end', window.until.toISOString());
      if (nextToken) url.searchParams.set('nextToken', nextToken);

      const response = await fetch(url, {
        headers: { authorization: `Bearer ${accessToken}` },
      });

      if (response.status === 401) {
        throw new ProviderAuthError('whoop', 'WHOOP rejected the access token.');
      }
      if (response.status === 429) {
        const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
        throw new ProviderRateLimitError(
          'whoop',
          Number.isNaN(retryAfter) ? undefined : retryAfter,
          'WHOOP rate limit reached.',
        );
      }
      if (!response.ok) {
        warnings.push(`WHOOP returned ${response.status} for ${path}.`);
        break;
      }

      const body = (await response.json()) as WhoopPaginated<T>;
      out.push(...(body.records ?? []));
      nextToken = body.next_token;
      pages++;

      if (pages >= MAX_PAGES_PER_COLLECTION && nextToken) {
        warnings.push(`More WHOOP history is available for ${path} and will continue syncing.`);
        break;
      }
    } while (nextToken);

    return out;
  }

  private toTokens(body: WhoopTokenResponse): OAuthTokens {
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : undefined,
      scopes: body.scope ? body.scope.split(/\s+/).filter(Boolean) : [...WHOOP_SCOPES],
    };
  }
}
