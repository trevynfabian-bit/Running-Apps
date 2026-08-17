/**
 * Unit conversion and formatting.
 *
 * Canonical internal units, used by every engine and every stored record:
 *   distance  metres
 *   duration  seconds
 *   pace      seconds per kilometre
 *   speed     metres per second
 *   mass      kilograms
 *   elevation metres
 *
 * Imperial output is a presentation concern only; nothing is ever stored in
 * miles or pounds.
 */

export type DistanceUnit = 'metric' | 'imperial';

export const METERS_PER_KM = 1000;
export const METERS_PER_MILE = 1609.344;

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

export const kmToMeters = (km: number): number => km * METERS_PER_KM;
export const metersToKm = (m: number): number => m / METERS_PER_KM;
export const milesToMeters = (mi: number): number => mi * METERS_PER_MILE;
export const metersToMiles = (m: number): number => m / METERS_PER_MILE;

// ---------------------------------------------------------------------------
// Pace <-> speed
// ---------------------------------------------------------------------------

/** Convert m/s to seconds per kilometre. Returns undefined for non-positive speed. */
export function speedToPace(metersPerSecond: number): number | undefined {
  if (metersPerSecond <= 0) return undefined;
  return METERS_PER_KM / metersPerSecond;
}

/** Convert seconds per kilometre to m/s. Returns undefined for non-positive pace. */
export function paceToSpeed(secondsPerKm: number): number | undefined {
  if (secondsPerKm <= 0) return undefined;
  return METERS_PER_KM / secondsPerKm;
}

/** Average pace implied by a distance and a duration. */
export function computePace(
  distanceMeters: number,
  durationSeconds: number,
): number | undefined {
  if (distanceMeters <= 0 || durationSeconds <= 0) return undefined;
  return (durationSeconds / distanceMeters) * METERS_PER_KM;
}

export const paceKmToMile = (secondsPerKm: number): number =>
  secondsPerKm * (METERS_PER_MILE / METERS_PER_KM);

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a duration as `H:MM:SS`, or `M:SS` when under an hour.
 * Negative inputs are clamped to zero — a negative duration is always a bug
 * upstream and showing "-1:23" to an athlete helps nobody.
 */
export function formatDuration(totalSeconds: number, forceHours = false): string {
  const safe = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;

  if (hours > 0 || forceHours) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Format a pace as `M:SS/km` (or `/mi`). */
export function formatPace(secondsPerKm: number, unit: DistanceUnit = 'metric'): string {
  if (!Number.isFinite(secondsPerKm) || secondsPerKm <= 0) return '—';
  const value = unit === 'metric' ? secondsPerKm : paceKmToMile(secondsPerKm);
  const rounded = Math.round(value);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}/${unit === 'metric' ? 'km' : 'mi'}`;
}

/** Format a pace range as `M:SS–M:SS/km`. */
export function formatPaceRange(
  fastSecondsPerKm: number,
  slowSecondsPerKm: number,
  unit: DistanceUnit = 'metric',
): string {
  const fast = formatPace(fastSecondsPerKm, unit).split('/')[0]!;
  const slow = formatPace(slowSecondsPerKm, unit);
  return `${fast}–${slow}`;
}

/** Format a distance with sensible precision for the magnitude. */
export function formatDistance(meters: number, unit: DistanceUnit = 'metric'): string {
  if (!Number.isFinite(meters) || meters < 0) return '—';
  if (unit === 'imperial') {
    const mi = metersToMiles(meters);
    return `${mi.toFixed(mi < 10 ? 2 : 1)} mi`;
  }
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = metersToKm(meters);
  return `${km.toFixed(km < 10 ? 2 : 1)} km`;
}

/**
 * Parse a `M:SS` or `H:MM:SS` string into seconds.
 * Returns undefined for anything malformed rather than guessing.
 */
export function parseDuration(input: string): number | undefined {
  const trimmed = input.trim();
  if (!/^\d{1,2}(:\d{1,2}){1,2}$/.test(trimmed)) return undefined;

  const parts = trimmed.split(':').map(Number);
  if (parts.some((p) => Number.isNaN(p))) return undefined;

  if (parts.length === 2) {
    const [m, s] = parts as [number, number];
    if (s >= 60) return undefined;
    return m * 60 + s;
  }
  const [h, m, s] = parts as [number, number, number];
  if (m >= 60 || s >= 60) return undefined;
  return h * 3600 + m * 60 + s;
}

/** Format a signed delta of seconds, e.g. `-2:14` or `+0:08`. */
export function formatSignedDuration(deltaSeconds: number): string {
  const sign = deltaSeconds < 0 ? '−' : '+';
  return `${sign}${formatDuration(Math.abs(deltaSeconds))}`;
}
