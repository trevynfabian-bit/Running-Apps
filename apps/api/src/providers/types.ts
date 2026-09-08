/**
 * Provider abstraction.
 *
 * Every data source implements the same contract so the sync engine and the
 * rest of the app never branch on "is this Strava or WHOOP". Crucially, no
 * provider is ever assumed to be present: any combination of connected and
 * disconnected sources is a valid state.
 *
 * Adding Garmin, COROS, Polar or Oura later means implementing this interface
 * and registering it — no changes to the sync engine, the dedup pipeline, or
 * any screen.
 */

import type { ProviderId, ProviderWorkout } from '@running/core';

export type ConnectionStatus = 'connected' | 'disconnected' | 'expired' | 'error' | 'syncing';

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
  /** The provider's own user id, used to route webhooks. */
  externalUserId?: string;
}

export interface SyncWindow {
  /** Fetch records at or after this instant. */
  since?: Date;
  until?: Date;
  /** Provider-specific pagination cursor from the previous run. */
  cursor?: unknown;
}

export interface NormalizedBodyMeasurement {
  metric: 'weight_kg' | 'height_m' | 'max_hr' | 'resting_hr';
  originalValue: number;
  normalizedValue: number;
  transformation?: string;
  measuredAt: Date;
}

export interface NormalizedRecovery {
  externalId: string;
  localDate: string;
  recoveryScore?: number;
  hrvRmssdMs?: number;
  restingHeartRateBpm?: number;
  spo2Percent?: number;
  skinTempCelsius?: number;
  calibrating?: boolean;
  raw: unknown;
}

export interface NormalizedSleep {
  externalId: string;
  localDate: string;
  start: Date;
  end: Date;
  totalSleepSeconds: number;
  timeInBedSeconds?: number;
  lightSleepSeconds?: number;
  deepSleepSeconds?: number;
  remSleepSeconds?: number;
  awakeSeconds?: number;
  performancePercent?: number;
  consistencyPercent?: number;
  efficiencyPercent?: number;
  respiratoryRate?: number;
  disturbanceCount?: number;
  isNap: boolean;
  raw: unknown;
}

/** Everything one sync pass produced, before persistence. */
export interface ProviderSyncPayload {
  workouts: ProviderWorkout[];
  recoveries: NormalizedRecovery[];
  sleep: NormalizedSleep[];
  bodyMeasurements: NormalizedBodyMeasurement[];
  /** Cursor to persist for the next incremental run. */
  nextCursor?: unknown;
  /** Non-fatal problems worth surfacing without failing the whole sync. */
  warnings: string[];
}

export function emptyPayload(): ProviderSyncPayload {
  return { workouts: [], recoveries: [], sleep: [], bodyMeasurements: [], warnings: [] };
}

/**
 * What a provider can do. Not every provider supports everything: HealthKit
 * has no server API to poll, and only some support webhooks.
 */
export interface ProviderCapabilities {
  /** Can the server pull data, or must the device push it? */
  serverPull: boolean;
  webhooks: boolean;
  workouts: boolean;
  recovery: boolean;
  sleep: boolean;
  bodyMeasurements: boolean;
  routes: boolean;
}

export interface FitnessDataProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  /** Scopes this integration requests, for the permissions UI. */
  readonly scopes: readonly string[];
  /** Plain-language description of what connecting grants access to. */
  readonly dataDescription: readonly string[];

  /** True when the deployment has credentials for this provider. */
  isConfigured(): boolean;

  /** Build the provider's authorization URL for the OAuth redirect. */
  buildAuthorizationUrl(args: { state: string }): string;

  /** Exchange an authorization code for tokens. */
  exchangeCode(code: string): Promise<OAuthTokens>;

  /** Refresh an expiring access token. */
  refreshTokens(refreshToken: string): Promise<OAuthTokens>;

  /** Revoke access at the provider. Best-effort: local disconnect still wins. */
  revoke(accessToken: string): Promise<void>;

  /** Fetch and normalise a window of data. */
  sync(args: { tokens: OAuthTokens; window: SyncWindow; athleteId: string; timezone: string }): Promise<ProviderSyncPayload>;
}

/** Thrown when a provider rejects our credentials and a refresh won't help. */
export class ProviderAuthError extends Error {
  constructor(
    readonly provider: ProviderId,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderAuthError';
  }
}

/** Thrown when a provider rate-limits us. Carries retry timing when known. */
export class ProviderRateLimitError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly retryAfterSeconds: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderRateLimitError';
  }
}
