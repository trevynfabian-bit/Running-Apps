/**
 * Apple Health / HealthKit provider.
 *
 * HealthKit is fundamentally different from Strava and WHOOP: there is no
 * server-side API. HealthKit data lives on the device inside the user's
 * encrypted health store, and Apple provides no mechanism for a backend to
 * read it. Anything claiming otherwise is not talking about HealthKit.
 *
 * So the flow inverts. The iOS app reads via the native module (see
 * modules/health-kit) and POSTs normalised samples to
 * `POST /api/connections/healthkit/ingest`. This class exists to keep
 * HealthKit inside the same provider abstraction — connection status,
 * permissions display, disconnection, deletion — while making the pull
 * methods explicitly unsupported rather than silently returning nothing.
 */

import type {
  FitnessDataProvider,
  OAuthTokens,
  ProviderCapabilities,
  ProviderSyncPayload,
} from '../types.js';
import { emptyPayload } from '../types.js';

const CAPABILITIES: ProviderCapabilities = {
  // The defining difference: the server cannot pull. The device pushes.
  serverPull: false,
  webhooks: false,
  workouts: true,
  recovery: false,
  sleep: true,
  bodyMeasurements: true,
  routes: true,
};

/**
 * HealthKit permission identifiers we request, mirrored in the native module.
 * Requesting only what the product actually uses keeps the iOS permission
 * sheet honest and short.
 */
export const HEALTHKIT_READ_TYPES = [
  'HKWorkoutTypeIdentifier',
  'HKQuantityTypeIdentifierHeartRate',
  'HKQuantityTypeIdentifierRestingHeartRate',
  'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
  'HKQuantityTypeIdentifierActiveEnergyBurned',
  'HKQuantityTypeIdentifierDistanceWalkingRunning',
  'HKQuantityTypeIdentifierStepCount',
  'HKQuantityTypeIdentifierBodyMass',
  'HKQuantityTypeIdentifierHeight',
  'HKQuantityTypeIdentifierVO2Max',
  'HKQuantityTypeIdentifierRunningSpeed',
  'HKQuantityTypeIdentifierRunningPower',
  'HKQuantityTypeIdentifierRunningStrideLength',
  'HKQuantityTypeIdentifierRunningVerticalOscillation',
  'HKQuantityTypeIdentifierRunningGroundContactTime',
  'HKCategoryTypeIdentifierSleepAnalysis',
  'HKSeriesTypeWorkoutRoute',
] as const;

export const HEALTHKIT_DATA_DESCRIPTION = [
  'Workouts recorded by your iPhone or Apple Watch',
  'Heart rate, resting heart rate and HRV',
  'Running metrics such as power, cadence and stride length',
  'Body weight and height',
  'Sleep analysis',
] as const;

/** Thrown when someone tries to use HealthKit as a server-pull source. */
export class HealthKitPullUnsupportedError extends Error {
  constructor() {
    super(
      'Apple Health data cannot be read from a server. It is read on-device by the iOS app and pushed to the ingest endpoint.',
    );
    this.name = 'HealthKitPullUnsupportedError';
  }
}

export class HealthKitProvider implements FitnessDataProvider {
  readonly id = 'healthkit' as const;
  readonly displayName = 'Apple Health';
  readonly capabilities = CAPABILITIES;
  readonly scopes = HEALTHKIT_READ_TYPES;
  readonly dataDescription = HEALTHKIT_DATA_DESCRIPTION;

  /** Always available: it needs no server-side credentials, only an iOS device. */
  isConfigured(): boolean {
    return true;
  }

  buildAuthorizationUrl(): string {
    throw new HealthKitPullUnsupportedError();
  }

  exchangeCode(): Promise<OAuthTokens> {
    throw new HealthKitPullUnsupportedError();
  }

  refreshTokens(): Promise<OAuthTokens> {
    throw new HealthKitPullUnsupportedError();
  }

  /**
   * Disconnecting is a local operation. iOS permissions are revoked by the
   * user in the Health app or Settings — no API can do it on their behalf, and
   * the app must not pretend otherwise.
   */
  async revoke(): Promise<void> {
    return;
  }

  /**
   * Returns empty rather than throwing: the sync engine may schedule a pass
   * for every connected provider, and HealthKit having nothing to pull is a
   * normal state, not an error.
   */
  async sync(): Promise<ProviderSyncPayload> {
    const payload = emptyPayload();
    payload.warnings.push(
      'Apple Health syncs from your iPhone. Open the app on iOS to import the latest data.',
    );
    return payload;
  }
}
