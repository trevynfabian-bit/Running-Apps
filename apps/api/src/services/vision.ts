/**
 * The photo-reading service, and what we can honestly say about it.
 *
 * Optional by design. The circumference equations run with nothing configured,
 * so an instance without vision credentials is a working instance with one
 * method fewer — not a broken one, and the status it reports should not read
 * like an outage.
 *
 * Three states, and the difference between them is what the athlete needs:
 *
 *   `active`      configured, and nothing has recently failed.
 *   `unavailable` no service is configured on this instance. Nothing is
 *                 broken and nothing will fix itself; the formula is the path.
 *   `failed`      configured, but the last attempt did not work. Worth
 *                 retrying, unlike `unavailable`.
 *
 * Collapsing the last two would send someone to retry a service that was never
 * there, or to give up on one that is briefly down.
 */

import { env } from '../env.js';
import { logger } from '../observability/logger.js';

export type VisionStatus = 'active' | 'unavailable' | 'failed';

export interface VisionStatusReport {
  status: VisionStatus;
  /** Whether this instance has a service configured at all. */
  configured: boolean;
  /** Athlete-facing sentence. Never mentions keys, hosts or providers. */
  message: string;
  /** When the last failure was seen, if there was one. */
  lastFailureAt?: string;
  /** True when the formula path should be suggested instead. */
  suggestFormula: boolean;
}

/**
 * How long a failure keeps the service marked as failed.
 *
 * Long enough that an athlete retrying immediately sees the same answer rather
 * than a green light that fails again, short enough that a recovered service is
 * not written off for the rest of the day.
 */
export const FAILURE_WINDOW_MS = 5 * 60 * 1000;

interface Failure {
  at: number;
  reason: string;
}

let lastFailure: Failure | undefined;

/** Record that a read failed. The reason stays server-side. */
export function recordVisionFailure(reason: string, now: Date = new Date()): void {
  lastFailure = { at: now.getTime(), reason };
  // The reason can carry provider detail, so it goes to the log and never to
  // the athlete-facing message.
  logger.warn('vision.failed', { reason });
}

/** Record that a read succeeded, clearing any recent failure. */
export function recordVisionSuccess(): void {
  lastFailure = undefined;
}

/** Test hook: forget any recorded outcome. */
export function resetVisionStateForTesting(): void {
  lastFailure = undefined;
}

export function isVisionConfigured(): boolean {
  return env().visionConfigured;
}

export function visionStatus(now: Date = new Date()): VisionStatusReport {
  if (!isVisionConfigured()) {
    return {
      status: 'unavailable',
      configured: false,
      message:
        'Reading photos is not available on this app. The measurements method needs only your tape and your height, and it runs entirely on your own data.',
      suggestFormula: true,
    };
  }

  const failedRecently =
    lastFailure !== undefined && now.getTime() - lastFailure.at < FAILURE_WINDOW_MS;

  if (failedRecently) {
    return {
      status: 'failed',
      configured: true,
      message:
        'The last attempt to read your photos did not finish. Your photos are untouched, so trying again is safe — or use the measurements method, which needs nothing from our servers.',
      lastFailureAt: new Date(lastFailure!.at).toISOString(),
      suggestFormula: true,
    };
  }

  return {
    status: 'active',
    configured: true,
    message:
      'Your session photos can be read. The result is a wider band than the measurements method gives, so it is worth reading both.',
    suggestFormula: false,
  };
}
