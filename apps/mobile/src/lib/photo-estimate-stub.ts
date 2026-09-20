/**
 * Simulated photo reading.
 *
 * Stands in for the server-side vision service so the whole flow — asking,
 * waiting, succeeding, failing, and reading the result — can be built and
 * clicked through before any of it exists. Every shape here is what the client
 * expects back, so swapping in the real call is a change of one function.
 *
 * Two product rules are encoded rather than faked:
 *
 *   **One reading per session.** Re-analysing the same photographs is out of
 *   scope, and it would also be dishonest: the same input through the same
 *   model gives the same answer, so a second "analysis" that produced a
 *   different number would be noise presented as new information. The result is
 *   cached, and a repeat request returns the stored one without going anywhere.
 *
 *   **A wider band than the tape.** A photograph is a weaker signal than a
 *   measurement, and the simulation must not imply otherwise — a fixture that
 *   made the photo method look sharper would train the wrong intuition into
 *   every screen built against it.
 */

import type { BodyFatEstimate } from './body-fat';

/**
 * Band width for a photo reading, in percentage points either side.
 *
 * Wider than the formula's published standard error, deliberately. A
 * photograph is a weaker signal than a tape measure, and a simulation that made
 * the photo method look sharper would train the wrong intuition into every
 * screen built against it.
 */
export const PHOTO_MARGIN = 4.5;

/** Where simulated readings land. Plausible, and deliberately not extreme. */
const SIMULATED_CENTRE = { min: 12, max: 28 } as const;

/** How long the simulated call takes, in ms. */
export const SIMULATED_LATENCY_MS = 1200;

/**
 * Stable hash of a session id.
 *
 * FNV-1a, chosen because it is four lines and deterministic across platforms.
 * Nothing security-relevant rests on it; it exists so the same session always
 * simulates the same reading.
 */
function hash(input: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/**
 * The band a given session simulates.
 *
 * Pure and deterministic: same session id, same band, every time and on every
 * device. That is the point — it models "analysed once" rather than pretending
 * to re-read the photographs.
 */
export function simulatedPhotoBand(sessionId: string): { valueLow: number; valueHigh: number } {
  const span = SIMULATED_CENTRE.max - SIMULATED_CENTRE.min;
  // Two decimal places of spread from the hash, then rounded to one.
  const centre = SIMULATED_CENTRE.min + (hash(sessionId) % (span * 10)) / 10;

  return {
    valueLow: Number((centre - PHOTO_MARGIN).toFixed(1)),
    valueHigh: Number((centre + PHOTO_MARGIN).toFixed(1)),
  };
}

export function simulatedPhotoEstimate(sessionId: string): BodyFatEstimate {
  const band = simulatedPhotoBand(sessionId);

  return {
    id: `photo-${sessionId}`,
    sessionId,
    method: 'ai',
    ...band,
    // A photograph never earns more than low confidence here. It is the
    // weakest signal on offer and the label should say so.
    confidence: 'low',
    serviceStatus: 'active',
    basis: 'Visual estimate from the four photos in this session.',
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// The simulated call
// ---------------------------------------------------------------------------

export type PhotoEstimateState =
  | { status: 'idle' }
  | { status: 'requesting' }
  | { status: 'done'; estimate: BodyFatEstimate; fromCache: boolean }
  | { status: 'failed'; reason: string };

const cache = new Map<string, BodyFatEstimate>();

/** Forget every cached reading. Used by tests and by sign-out. */
export function clearPhotoEstimateCache(): void {
  cache.clear();
}

/**
 * Forget the reading held for one session.
 *
 * Called when that session is deleted. A deletion that leaves a cached
 * body-fat reading behind is not a deletion — the number derived from someone's
 * photographs is as much about their body as the photographs were, and it would
 * outlive the thing it was derived from.
 *
 * Returns whether there was one, so the confirmation can say so.
 */
export function clearPhotoEstimateFor(sessionId: string): boolean {
  return cache.delete(sessionId);
}

/** A reading already held for this session, if any. */
export function cachedPhotoEstimate(sessionId: string): BodyFatEstimate | undefined {
  return cache.get(sessionId);
}

export interface RequestOptions {
  /** Simulate the service failing, to exercise that path. */
  failWith?: string;
  /** Override the delay. Tests pass 0; the screen uses the default. */
  latencyMs?: number;
}

/**
 * Ask the simulated service to read a session's photos.
 *
 * Returns the cached reading immediately when there is one — no delay, no
 * second "analysis". A caller that wants to know whether it waited can read
 * `fromCache` on the result.
 */
export async function requestPhotoEstimate(
  sessionId: string,
  options: RequestOptions = {},
): Promise<PhotoEstimateState> {
  const cached = cache.get(sessionId);
  if (cached) return { status: 'done', estimate: cached, fromCache: true };

  const latency = options.latencyMs ?? SIMULATED_LATENCY_MS;
  if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));

  if (options.failWith) {
    // A failure is not cached: the photos were never read, so asking again is
    // a legitimate thing to do rather than a repeat analysis.
    return { status: 'failed', reason: options.failWith };
  }

  const estimate = simulatedPhotoEstimate(sessionId);
  cache.set(sessionId, estimate);
  return { status: 'done', estimate, fromCache: false };
}
