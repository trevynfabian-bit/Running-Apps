/**
 * Body fat estimates — client types and stub data.
 *
 * The single most important thing about this screen is what it refuses to say.
 * Every method available here is an estimate built from proxies: a tape measure
 * and a set of population-fitted coefficients, or a photograph. None of them
 * measures body fat. They produce a plausible band, and a band is what the
 * athlete is shown.
 *
 * So the shape below has no `value` field. There is a low and a high, and code
 * that wants "the number" has to decide for itself what to do with a range —
 * which is the point. A single figure with one decimal place reads as a
 * measurement, gets written in a training log, and gets compared week to week
 * as though the difference meant something.
 *
 * The API for this does not exist yet; the fixtures stand in for it.
 */

export type BodyFatMethod = 'formula' | 'ai';

/**
 * How much weight the athlete should put on a result.
 *
 * Driven by what went into it: a formula with every input present and a recent
 * weight is `moderate`, the same formula missing a measurement drops to `low`,
 * and nothing here ever reaches certainty.
 */
export type ConfidenceLabel = 'low' | 'moderate' | 'high';

/** Whether the server-side vision service could be used at all. */
export type ServiceStatus = 'active' | 'unavailable' | 'failed';

export interface BodyFatEstimate {
  id: string;
  sessionId: string;
  method: BodyFatMethod;
  /** Lower bound, percent. */
  valueLow: number;
  /** Upper bound, percent. */
  valueHigh: number;
  confidence: ConfidenceLabel;
  /** Only meaningful for the AI method. */
  serviceStatus?: ServiceStatus;
  /** One sentence on what this result rests on. */
  basis: string;
  createdAt: string;
}

export const METHOD_LABELS: Record<BodyFatMethod, string> = {
  formula: 'From measurements',
  ai: 'From photos',
};

export const METHOD_DESCRIPTIONS: Record<BodyFatMethod, string> = {
  formula:
    'A published formula applied to your circumferences and height. Every input and step is shown.',
  ai: 'Your session photos are read by a service on our server. Availability varies, and the formula is always there.',
};

export const CONFIDENCE_LABELS: Record<ConfidenceLabel, string> = {
  low: 'Low confidence',
  moderate: 'Moderate confidence',
  high: 'High confidence',
};

/**
 * The disclaimer.
 *
 * Kept as one exported constant rather than typed into each screen, so it
 * cannot quietly soften in one place and not another.
 */
export const NON_MEDICAL_NOTE =
  'This is an estimate, not a medical measurement. It is useful for watching a trend over months, not for a diagnosis or a decision about your health.';

/** Format an estimate as the band it is. */
export function formatRange(estimate: Pick<BodyFatEstimate, 'valueLow' | 'valueHigh'>): string {
  if (!Number.isFinite(estimate.valueLow) || !Number.isFinite(estimate.valueHigh)) return '—';
  // En dash, and one decimal: the width of the band already says how precise
  // this is, so the digits do not need to overstate it.
  return `${estimate.valueLow.toFixed(1)}–${estimate.valueHigh.toFixed(1)}%`;
}

/** How wide the band is, in percentage points. */
export function rangeWidth(estimate: Pick<BodyFatEstimate, 'valueLow' | 'valueHigh'>): number {
  return Math.abs(estimate.valueHigh - estimate.valueLow);
}

/**
 * Stub estimates for the most recent session.
 *
 * Both methods present, with the formula deliberately the tighter of the two —
 * a tape measure against fitted coefficients is more repeatable than a
 * photograph, and the fixtures should not imply otherwise.
 */
export const STUB_ESTIMATES: readonly BodyFatEstimate[] = [
  {
    id: 'estimate-formula-2026-09-06',
    sessionId: 'session-2026-09-06',
    method: 'formula',
    valueLow: 17.4,
    valueHigh: 20.2,
    confidence: 'moderate',
    basis: 'US Navy formula from neck, waist and height, with weight from 4 days ago.',
    createdAt: '2026-09-06T07:50:00.000Z',
  },
  {
    id: 'estimate-ai-2026-09-06',
    sessionId: 'session-2026-09-06',
    method: 'ai',
    valueLow: 16.0,
    valueHigh: 21.5,
    confidence: 'low',
    serviceStatus: 'active',
    basis: 'Visual estimate from the four photos in this session.',
    createdAt: '2026-09-06T07:51:00.000Z',
  },
];

export function estimateFor(
  estimates: readonly BodyFatEstimate[],
  method: BodyFatMethod,
): BodyFatEstimate | undefined {
  return estimates.find((estimate) => estimate.method === method);
}

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

/**
 * Ends of the scale an estimate is drawn against.
 *
 * Wide enough to hold any plausible reading without the band sitting at an
 * edge, and deliberately carrying no zones: marking off "essential", "athletic"
 * or "high" is the medical judgement the notice disclaims, and those thresholds
 * vary by sex, age and the method used to define them — none of which this
 * estimate knows.
 */
export const BODY_FAT_SCALE = { min: 5, max: 45 } as const;

/**
 * Where a value sits on the scale, as a fraction from 0 to 1.
 *
 * Clamped, so a reading outside the drawn scale pins to the edge rather than
 * overflowing the track — a band running off the end would look like a
 * rendering bug rather than an unusual measurement.
 */
export function scalePosition(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const span = BODY_FAT_SCALE.max - BODY_FAT_SCALE.min;
  return Math.min(1, Math.max(0, (value - BODY_FAT_SCALE.min) / span));
}

/** Minimum drawn width, so a band that rounds to nothing is still visible. */
export const MIN_BAND_FRACTION = 0.012;

/**
 * Start and width of the drawn band, as fractions of the track.
 *
 * Tolerates bounds given the wrong way round: an estimate is a range whichever
 * order its ends arrive in, and swapping them silently beats drawing nothing.
 */
export function bandGeometry(low: number, high: number): { start: number; width: number } {
  const start = scalePosition(Math.min(low, high));
  const end = scalePosition(Math.max(low, high));
  return { start, width: Math.max(end - start, MIN_BAND_FRACTION) };
}
