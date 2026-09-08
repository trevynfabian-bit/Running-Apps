/**
 * `@running/health-kit` — typed TypeScript surface over the native iOS module.
 *
 * Everything here is safe to call on any platform. On Android, web, or an iPad
 * without a health store, calls resolve to empty results rather than throwing,
 * so screens never need to branch on platform before rendering.
 *
 * A note on permissions that shapes the whole API: iOS never discloses whether
 * READ access was granted. Apple treats that as privacy-sensitive, because
 * "this query returned nothing" would otherwise reveal that the user has no
 * data of that kind. So `requestAuthorization` reports only that the sheet was
 * shown, and an empty result always means "nothing to report" — never "denied".
 * The UI must be written to that reality instead of implying certainty.
 */

import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

export interface HealthKitWorkout {
  uuid: string;
  activityType: string;
  startDate: string;
  endDate: string;
  durationSeconds: number;
  distanceMeters?: number;
  avgHeartRateBpm?: number;
  maxHeartRateBpm?: number;
  totalEnergyKcal?: number;
  isIndoor: boolean;
  sourceName?: string;
}

export interface HealthKitSample {
  uuid: string;
  type: string;
  startDate: string;
  endDate?: string;
  value: number;
  unit: string;
  stage?: string;
  sourceName?: string;
}

export interface HealthKitRoutePoint {
  lat: number;
  lon: number;
  elevationMeters?: number;
  timestamp?: string;
}

export interface AuthorizationResult {
  granted: boolean;
  available: boolean;
  reason?: string;
  note?: string;
}

/** Quantity types this module can read. */
export type QuantityIdentifier =
  | 'heart_rate'
  | 'resting_heart_rate'
  | 'hrv'
  | 'body_mass'
  | 'height'
  | 'vo2_max'
  | 'active_energy'
  | 'step_count'
  | 'distance'
  | 'running_speed'
  | 'running_power'
  | 'stride_length'
  | 'vertical_oscillation'
  | 'ground_contact_time';

interface NativeModule {
  isAvailable(): boolean;
  requestAuthorization(): Promise<AuthorizationResult>;
  authorizationStatusForSharing(identifier: string): string;
  getWorkouts(startISO: string, endISO: string, limit: number): Promise<HealthKitWorkout[]>;
  getHeartRateSamples(startISO: string, endISO: string): Promise<HealthKitSample[]>;
  getQuantitySamples(
    identifier: string,
    startISO: string,
    endISO: string,
    limit: number,
  ): Promise<HealthKitSample[]>;
  getWorkoutRoute(workoutUUID: string): Promise<HealthKitRoutePoint[]>;
  getSleepSamples(startISO: string, endISO: string): Promise<HealthKitSample[]>;
}

/**
 * `requireOptionalNativeModule` returns null when the native module isn't in
 * the binary — Android, web, Expo Go, or a build made before the module was
 * added. That is a normal state, not an error.
 */
const native = requireOptionalNativeModule<NativeModule>('RunningHealthKit');

/** True only where a real HealthKit store can be reached. */
export function isHealthKitAvailable(): boolean {
  if (Platform.OS !== 'ios' || !native) return false;
  try {
    return native.isAvailable();
  } catch {
    return false;
  }
}

/**
 * Present the HealthKit permission sheet.
 *
 * `granted` means the sheet completed without error — not that any particular
 * type is readable. Copy shown to the user must not overstate this.
 */
export async function requestAuthorization(): Promise<AuthorizationResult> {
  if (!isHealthKitAvailable()) {
    return {
      granted: false,
      available: false,
      reason:
        Platform.OS === 'ios'
          ? 'Health data is not available on this device.'
          : 'Apple Health is only available on iPhone.',
    };
  }
  return native!.requestAuthorization();
}

export async function getWorkouts(options: {
  start: Date;
  end: Date;
  limit?: number;
}): Promise<HealthKitWorkout[]> {
  if (!isHealthKitAvailable()) return [];
  try {
    return await native!.getWorkouts(
      options.start.toISOString(),
      options.end.toISOString(),
      options.limit ?? 0,
    );
  } catch {
    // Degrade to "no data" — the caller cannot distinguish denial from
    // absence anyway, and neither can we.
    return [];
  }
}

export async function getHeartRateSamples(options: {
  start: Date;
  end: Date;
}): Promise<HealthKitSample[]> {
  if (!isHealthKitAvailable()) return [];
  try {
    return await native!.getHeartRateSamples(
      options.start.toISOString(),
      options.end.toISOString(),
    );
  } catch {
    return [];
  }
}

export async function getQuantitySamples(options: {
  identifier: QuantityIdentifier;
  start: Date;
  end: Date;
  limit?: number;
}): Promise<HealthKitSample[]> {
  if (!isHealthKitAvailable()) return [];
  try {
    return await native!.getQuantitySamples(
      options.identifier,
      options.start.toISOString(),
      options.end.toISOString(),
      options.limit ?? 0,
    );
  } catch {
    return [];
  }
}

export async function getWorkoutRoute(workoutUuid: string): Promise<HealthKitRoutePoint[]> {
  if (!isHealthKitAvailable()) return [];
  try {
    return await native!.getWorkoutRoute(workoutUuid);
  } catch {
    return [];
  }
}

export async function getSleepSamples(options: {
  start: Date;
  end: Date;
}): Promise<HealthKitSample[]> {
  if (!isHealthKitAvailable()) return [];
  try {
    return await native!.getSleepSamples(options.start.toISOString(), options.end.toISOString());
  } catch {
    return [];
  }
}

/**
 * Read everything the backend ingest endpoint accepts, in one pass.
 *
 * Each read is independent: one denied permission reduces what we collect
 * rather than failing the whole import.
 */
export async function collectForIngest(options: {
  since: Date;
  until?: Date;
}): Promise<{ workouts: HealthKitWorkout[]; samples: HealthKitSample[] }> {
  const end = options.until ?? new Date();

  if (!isHealthKitAvailable()) return { workouts: [], samples: [] };

  const [workouts, weight, restingHr, hrv, vo2max, sleep] = await Promise.all([
    getWorkouts({ start: options.since, end }),
    getQuantitySamples({ identifier: 'body_mass', start: options.since, end }),
    getQuantitySamples({ identifier: 'resting_heart_rate', start: options.since, end }),
    getQuantitySamples({ identifier: 'hrv', start: options.since, end }),
    getQuantitySamples({ identifier: 'vo2_max', start: options.since, end }),
    getSleepSamples({ start: options.since, end }),
  ]);

  return {
    workouts,
    samples: [...weight, ...restingHr, ...hrv, ...vo2max, ...sleep],
  };
}

/**
 * Athlete-facing descriptions of what each permission is used for.
 * Shown alongside the system sheet, which by itself explains nothing about
 * why an app wants a given metric.
 */
export const HEALTHKIT_PERMISSION_PURPOSES: { label: string; purpose: string }[] = [
  { label: 'Workouts', purpose: 'Import runs recorded on your iPhone or Apple Watch.' },
  { label: 'Heart rate', purpose: 'Calculate training load, zones and aerobic efficiency.' },
  { label: 'Resting heart rate', purpose: 'Track recovery against your own baseline.' },
  { label: 'Heart rate variability', purpose: 'Detect accumulated fatigue.' },
  { label: 'Running metrics', purpose: 'Analyse power, cadence and stride where available.' },
  { label: 'Body weight', purpose: 'Track weight trends alongside training.' },
  { label: 'Sleep', purpose: 'Factor sleep into your daily readiness.' },
];
