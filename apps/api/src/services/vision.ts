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

// ---------------------------------------------------------------------------
// Reading photos
// ---------------------------------------------------------------------------

/**
 * Band width for a photo reading, in percentage points either side.
 *
 * Wider than either circumference equation's published error. A photograph is
 * the weakest signal on offer here — lighting, posture and clothing all move
 * the answer — and the band has to say so rather than letting the newest method
 * look like the most precise one.
 */
export const PHOTO_MARGIN = 4.5;

/** Largest span we will accept back before treating the reading as useless. */
const MAX_USEFUL_SPAN = 20;

export interface PhotoForAnalysis {
  side: string;
  contentType: string;
  bytes: Buffer;
}

export type PhotoReading =
  { ok: true; valueLow: number; valueHigh: number; note: string } | { ok: false; reason: string };

/**
 * What the model is asked to do, and what it is asked not to.
 *
 * The instruction to refuse rather than guess matters more than the estimate
 * itself: a confident number from an unusable photo is worse than no number,
 * because the athlete has no way to tell the two apart.
 */
const SYSTEM_PROMPT = `You are estimating body fat percentage from four standardised body photos (front, back, left, right) for an athlete tracking their own composition over time.

Rules:
- Return a RANGE, never a single figure. Visual estimation is imprecise and the range must reflect that honestly.
- If the photos are unclear, heavily clothed, badly lit, cropped, or otherwise unusable, say so instead of guessing. A refusal is a useful answer; a confident number from an unusable photo is not.
- Do not comment on the person's appearance, health, attractiveness, or anything beyond the estimate itself.
- Do not diagnose. This is not a medical assessment.`;

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
}

/**
 * Ask the vision service to read a set of photos.
 *
 * Only the images are sent. No name, no athlete id, no measurements, no
 * training history — the service is asked to look at pictures, and nothing it
 * receives would identify whose they are if it were logged at the other end.
 *
 * Structured output is used so the answer comes back as a band or not at all,
 * rather than as prose a parser has to guess at.
 */
export async function analysePhotos(photos: readonly PhotoForAnalysis[]): Promise<PhotoReading> {
  const config = env();

  if (!config.visionConfigured) {
    return { ok: false, reason: 'No photo-reading service is configured.' };
  }
  if (photos.length === 0) {
    return { ok: false, reason: 'There were no photos to read.' };
  }

  try {
    const response = await fetch(`${config.VISION_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.VISION_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.VISION_MODEL,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        // A schema rather than prose: the answer is a band or it is a refusal,
        // and neither has to be parsed out of a sentence.
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['usable'],
              properties: {
                usable: { type: 'boolean' },
                valueLow: { type: 'number' },
                valueHigh: { type: 'number' },
                note: { type: 'string' },
                reason: { type: 'string' },
              },
            },
          },
        },
        messages: [
          {
            role: 'user',
            content: [
              // Images before the instruction, which is the documented order.
              ...photos.map((photo) => ({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: photo.contentType,
                  data: photo.bytes.toString('base64'),
                },
              })),
              {
                type: 'text',
                text: `These are the ${photos.length} sides of one session: ${photos
                  .map((photo) => photo.side)
                  .join(
                    ', ',
                  )}. Give a body fat percentage range, or say the photos are not usable.`,
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      recordVisionFailure(`http ${response.status}`);
      return { ok: false, reason: 'The photo service did not respond successfully.' };
    }

    const body = (await response.json()) as AnthropicResponse;

    if (body.stop_reason === 'refusal') {
      recordVisionFailure('model declined');
      return { ok: false, reason: 'The photo service declined to read these photos.' };
    }

    const text = body.content
      ?.filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
      .trim();

    if (!text) {
      recordVisionFailure('empty response');
      return { ok: false, reason: 'The photo service returned nothing to read.' };
    }

    let parsed: {
      usable?: boolean;
      valueLow?: number;
      valueHigh?: number;
      note?: string;
      reason?: string;
    };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      recordVisionFailure('unparseable response');
      return { ok: false, reason: 'The photo service returned an answer we could not read.' };
    }

    if (parsed.usable === false) {
      // Not a service failure: the service worked and told us the photos are
      // not good enough. Marking it failed would send the athlete to retry
      // something that will give the same answer.
      recordVisionSuccess();
      return {
        ok: false,
        reason:
          parsed.reason ??
          'These photos could not be read clearly enough for an estimate. A retake in better light usually fixes it.',
      };
    }

    const low = Number(parsed.valueLow);
    const high = Number(parsed.valueHigh);

    if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= low) {
      recordVisionFailure('nonsense band');
      return { ok: false, reason: 'The photo service returned a range that does not make sense.' };
    }

    if (high - low > MAX_USEFUL_SPAN) {
      // A band this wide covers most of the plausible human range and tells the
      // athlete nothing; better to say it could not read them.
      recordVisionSuccess();
      return {
        ok: false,
        reason:
          'The photos gave too wide a range to be worth showing. The measurements method will be more useful here.',
      };
    }

    recordVisionSuccess();
    return {
      ok: true,
      valueLow: Number(low.toFixed(1)),
      valueHigh: Number(high.toFixed(1)),
      note: parsed.note ?? 'Visual estimate from the four photos in this session.',
    };
  } catch (error) {
    recordVisionFailure(String(error));
    return {
      ok: false,
      reason: 'We could not reach the photo service. Your photos are untouched.',
    };
  }
}
