/**
 * Data provenance.
 *
 * Rule for the whole system: a value the athlete sees must be able to explain
 * where it came from. Conflicting values from different providers are kept
 * side by side and resolved by an explicit, inspectable policy — never by a
 * silent last-write-wins overwrite.
 */

export type ProviderId = 'strava' | 'whoop' | 'healthkit' | 'manual' | 'derived';

/** How much we trust a value, independent of which provider produced it. */
export type ConfidenceLevel = 'low' | 'moderate' | 'high';

/**
 * A single provider's claim about a metric, retaining the original value so a
 * unit-conversion bug is always debuggable after the fact.
 */
export interface SourceRecord<T> {
  provider: ProviderId;
  /** The provider's own identifier for the underlying record, when it has one. */
  externalId?: string;
  /** Value exactly as the provider reported it, before any transformation. */
  originalValue: T;
  /** Value after conversion into our canonical units. */
  normalizedValue: T;
  /** Human-readable note on what was done, e.g. "lb → kg". */
  transformation?: string;
  /** When the provider says the measurement was taken. */
  measuredAt: Date;
  /** When we last pulled this record from the provider. */
  syncedAt: Date;
}

/**
 * A metric value plus the full set of claims behind it.
 * `value` is the resolved answer; `sources` is the evidence.
 */
export interface Sourced<T> {
  value: T;
  /** Provider whose claim won under the resolution policy. */
  selectedProvider: ProviderId;
  confidence: ConfidenceLevel;
  sources: SourceRecord<T>[];
  /** Why `selectedProvider` won, for the "where did this come from?" UI. */
  resolutionNote?: string;
}

/**
 * Default trust ordering when several providers report the same body metric.
 *
 * This is a *default*, not a truth claim. A manual entry outranks everything
 * because the athlete stepping on a scale and typing the number is a direct
 * observation; derived values rank last because they are inferred, not measured.
 */
export const DEFAULT_PROVIDER_PRIORITY: readonly ProviderId[] = [
  'manual',
  'healthkit',
  'whoop',
  'strava',
  'derived',
];

/**
 * Resolve competing source records into a single sourced value.
 *
 * Policy, in order:
 *   1. Prefer the most recent measurement when records differ by more than
 *      `recencyToleranceMs` — a newer weigh-in beats an older one regardless
 *      of provider.
 *   2. Within that recency band, prefer the higher-priority provider.
 *
 * Confidence reflects agreement: multiple providers that agree closely give
 * high confidence; a lone stale record gives low confidence.
 */
export function resolveSourced<T>(
  records: readonly SourceRecord<T>[],
  options: {
    priority?: readonly ProviderId[];
    recencyToleranceMs?: number;
    /** Supply for numeric metrics to let agreement raise confidence. */
    numericDistance?: (a: T, b: T) => number;
    /** Relative distance under which two values count as "agreeing". */
    agreementThreshold?: number;
  } = {},
): Sourced<T> | undefined {
  if (records.length === 0) return undefined;

  const priority = options.priority ?? DEFAULT_PROVIDER_PRIORITY;
  const tolerance = options.recencyToleranceMs ?? 24 * 60 * 60 * 1000;

  const rank = (p: ProviderId): number => {
    const i = priority.indexOf(p);
    return i === -1 ? priority.length : i;
  };

  const sorted = [...records].sort((a, b) => {
    const timeDelta = b.measuredAt.getTime() - a.measuredAt.getTime();
    if (Math.abs(timeDelta) > tolerance) return timeDelta;
    return rank(a.provider) - rank(b.provider);
  });

  const winner = sorted[0]!;

  let confidence: ConfidenceLevel = records.length > 1 ? 'moderate' : 'low';
  let resolutionNote =
    records.length === 1
      ? `Only ${winner.provider} reported this value.`
      : `${winner.provider} selected over ${records.length - 1} other source(s).`;

  if (options.numericDistance && records.length > 1) {
    const threshold = options.agreementThreshold ?? 0.02;
    const agree = sorted
      .slice(1)
      .every((r) => options.numericDistance!(winner.normalizedValue, r.normalizedValue) <= threshold);
    if (agree) {
      confidence = 'high';
      resolutionNote = `${records.length} sources agree within ${(threshold * 100).toFixed(0)}%.`;
    } else {
      confidence = 'moderate';
      resolutionNote = `Sources disagree; ${winner.provider} selected by recency and priority.`;
    }
  }

  return {
    value: winner.normalizedValue,
    selectedProvider: winner.provider,
    confidence,
    sources: [...records],
    resolutionNote,
  };
}

/** Relative distance between two numbers, for agreement checks. */
export function relativeDistance(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return 0;
  return Math.abs(a - b) / scale;
}
