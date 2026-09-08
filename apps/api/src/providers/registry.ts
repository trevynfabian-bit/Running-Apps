/**
 * Provider registry.
 *
 * The single place that decides which implementation backs each provider id.
 * In mock mode the real clients are swapped for generators with identical
 * interfaces, so no calling code changes and no network call is made.
 *
 * Adding a provider means adding one entry here.
 */

import type { ProviderId } from '@running/core';
import type { FitnessDataProvider } from './types.js';
import { StravaProvider } from './strava/provider.js';
import { WhoopProvider } from './whoop/provider.js';
import {
  HEALTHKIT_DATA_DESCRIPTION,
  HEALTHKIT_READ_TYPES,
  HealthKitProvider,
} from './healthkit/provider.js';
import { MockProvider } from './mock/index.js';
import { STRAVA_DATA_DESCRIPTION, STRAVA_SCOPES } from './strava/api.js';
import { WHOOP_DATA_DESCRIPTION, WHOOP_SCOPES } from './whoop/api.js';
import { env } from '../env.js';

/** Providers an athlete can connect. `manual` and `derived` are internal. */
export const CONNECTABLE_PROVIDERS = ['strava', 'whoop', 'healthkit'] as const;
export type ConnectableProvider = (typeof CONNECTABLE_PROVIDERS)[number];

export function isConnectableProvider(value: string): value is ConnectableProvider {
  return (CONNECTABLE_PROVIDERS as readonly string[]).includes(value);
}

let cache: Map<ProviderId, FitnessDataProvider> | undefined;

function build(): Map<ProviderId, FitnessDataProvider> {
  const config = env();
  const registry = new Map<ProviderId, FitnessDataProvider>();

  if (config.USE_MOCK_DATA) {
    registry.set(
      'strava',
      new MockProvider('strava', 'Strava', STRAVA_SCOPES, STRAVA_DATA_DESCRIPTION),
    );
    registry.set('whoop', new MockProvider('whoop', 'WHOOP', WHOOP_SCOPES, WHOOP_DATA_DESCRIPTION));
    registry.set(
      'healthkit',
      new MockProvider('healthkit', 'Apple Health', HEALTHKIT_READ_TYPES, HEALTHKIT_DATA_DESCRIPTION),
    );
    return registry;
  }

  registry.set('strava', new StravaProvider());
  registry.set('whoop', new WhoopProvider());
  registry.set('healthkit', new HealthKitProvider());
  return registry;
}

export function getProvider(id: ProviderId): FitnessDataProvider | undefined {
  cache ??= build();
  return cache.get(id);
}

export function listProviders(): FitnessDataProvider[] {
  cache ??= build();
  return [...cache.values()];
}

/** Drop the cache so a changed environment takes effect (tests, config reload). */
export function resetProviderRegistry(): void {
  cache = undefined;
}
