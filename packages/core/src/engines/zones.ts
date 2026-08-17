/**
 * Training zone computation.
 *
 * Several zone methodologies are supported because they answer different
 * questions and are anchored to different measurements. They are NOT
 * interchangeable: a "Zone 2" derived from %HRmax is a different intensity
 * from a "Zone 2" derived from heart-rate reserve. The athlete picks one
 * primary methodology and the whole app speaks that language; every computed
 * zone set carries the methodology that produced it so nothing can be mixed
 * by accident.
 *
 * Models implemented
 * ------------------
 * `max_hr_percent`  Zones as fixed percentages of maximum heart rate.
 *                   Simplest, but ignores resting HR, so it systematically
 *                   overstates intensity for athletes with a low resting HR.
 *
 * `hr_reserve`      Karvonen. Zones as percentages of (HRmax − HRrest),
 *                   added back onto HRrest. Accounts for individual resting
 *                   HR and generally tracks metabolic intensity better.
 *
 * `threshold_hr`    Zones anchored to lactate-threshold HR. Most defensible
 *                   when a real threshold estimate exists, because threshold
 *                   is a physiological boundary rather than an arbitrary
 *                   percentage.
 *
 * `pace_threshold`  Pace zones anchored to threshold pace.
 * `pace_vdot`       Pace zones derived from a VDOT-style fitness estimate.
 */

import type { ZoneMethodology } from '../domain/athlete.js';
import { clamp } from '../util/stats.js';

export interface Zone {
  /** 1-based zone number. */
  number: number;
  name: string;
  /** What this zone is for, in one line. */
  purpose: string;
  /** Inclusive lower bound. bpm for HR zones, seconds/km for pace zones. */
  lowerBound: number;
  /** Exclusive upper bound (Infinity-capped for the top zone). */
  upperBound: number;
}

export interface ZoneSet {
  methodology: ZoneMethodology;
  kind: 'heart_rate' | 'pace';
  zones: Zone[];
  /** The anchor values the zones were computed from, for explainability. */
  basis: Record<string, number>;
  /** Note describing what the athlete must do to improve accuracy. */
  note?: string;
}

/**
 * Five-zone model shared by the HR methodologies.
 * Boundaries are expressed as fractions of the relevant anchor.
 */
const ZONE_DEFINITIONS: readonly {
  number: number;
  name: string;
  purpose: string;
  maxHrPercent: [number, number];
  hrReservePercent: [number, number];
  thresholdHrPercent: [number, number];
}[] = [
  {
    number: 1,
    name: 'Recovery',
    purpose: 'Active recovery and blood flow',
    maxHrPercent: [0.5, 0.6],
    hrReservePercent: [0.3, 0.4],
    thresholdHrPercent: [0.6, 0.75],
  },
  {
    number: 2,
    name: 'Aerobic',
    purpose: 'Aerobic base and fat oxidation',
    maxHrPercent: [0.6, 0.7],
    hrReservePercent: [0.4, 0.6],
    thresholdHrPercent: [0.75, 0.87],
  },
  {
    number: 3,
    name: 'Tempo',
    purpose: 'Aerobic capacity and steady-state endurance',
    maxHrPercent: [0.7, 0.8],
    hrReservePercent: [0.6, 0.75],
    thresholdHrPercent: [0.87, 0.95],
  },
  {
    number: 4,
    name: 'Threshold',
    purpose: 'Lactate threshold and sustained speed',
    maxHrPercent: [0.8, 0.9],
    hrReservePercent: [0.75, 0.9],
    thresholdHrPercent: [0.95, 1.03],
  },
  {
    number: 5,
    name: 'VO₂max',
    purpose: 'Maximal aerobic power',
    maxHrPercent: [0.9, 1.0],
    hrReservePercent: [0.9, 1.0],
    thresholdHrPercent: [1.03, 1.15],
  },
];

export interface HeartRateZoneInputs {
  maxHeartRateBpm: number;
  restingHeartRateBpm?: number;
  thresholdHeartRateBpm?: number;
}

/**
 * Compute heart-rate zones under an explicit methodology.
 *
 * Throws if the methodology's required anchor is missing — callers must pick a
 * methodology they have data for. `selectHeartRateMethodology` does that safely.
 */
export function computeHeartRateZones(
  methodology: Extract<ZoneMethodology, 'max_hr_percent' | 'hr_reserve' | 'threshold_hr'>,
  inputs: HeartRateZoneInputs,
): ZoneSet {
  const { maxHeartRateBpm, restingHeartRateBpm, thresholdHeartRateBpm } = inputs;

  if (maxHeartRateBpm <= 0) {
    throw new Error('computeHeartRateZones: maxHeartRateBpm must be positive');
  }

  let bounds: [number, number][];
  let basis: Record<string, number>;
  let note: string | undefined;

  switch (methodology) {
    case 'max_hr_percent': {
      bounds = ZONE_DEFINITIONS.map((z) => [
        Math.round(z.maxHrPercent[0] * maxHeartRateBpm),
        Math.round(z.maxHrPercent[1] * maxHeartRateBpm),
      ]);
      basis = { maxHeartRateBpm };
      note = 'Percentage of maximum heart rate. Does not account for resting heart rate.';
      break;
    }
    case 'hr_reserve': {
      if (restingHeartRateBpm === undefined) {
        throw new Error('computeHeartRateZones: hr_reserve requires restingHeartRateBpm');
      }
      const reserve = maxHeartRateBpm - restingHeartRateBpm;
      if (reserve <= 0) {
        throw new Error('computeHeartRateZones: resting HR must be below max HR');
      }
      bounds = ZONE_DEFINITIONS.map((z) => [
        Math.round(restingHeartRateBpm + z.hrReservePercent[0] * reserve),
        Math.round(restingHeartRateBpm + z.hrReservePercent[1] * reserve),
      ]);
      basis = { maxHeartRateBpm, restingHeartRateBpm, heartRateReserve: reserve };
      note = 'Karvonen heart-rate reserve method, personalised to your resting heart rate.';
      break;
    }
    case 'threshold_hr': {
      if (thresholdHeartRateBpm === undefined) {
        throw new Error('computeHeartRateZones: threshold_hr requires thresholdHeartRateBpm');
      }
      bounds = ZONE_DEFINITIONS.map((z) => [
        Math.round(z.thresholdHrPercent[0] * thresholdHeartRateBpm),
        Math.round(z.thresholdHrPercent[1] * thresholdHeartRateBpm),
      ]);
      basis = { thresholdHeartRateBpm, maxHeartRateBpm };
      note = 'Anchored to your estimated lactate-threshold heart rate.';
      break;
    }
  }

  const zones: Zone[] = ZONE_DEFINITIONS.map((definition, index) => {
    const [lower, upper] = bounds[index]!;
    const isTop = index === ZONE_DEFINITIONS.length - 1;
    return {
      number: definition.number,
      name: definition.name,
      purpose: definition.purpose,
      lowerBound: lower,
      // The top zone is open-ended: an athlete can exceed their estimated max.
      upperBound: isTop ? Number.POSITIVE_INFINITY : upper,
    };
  });

  return { methodology, kind: 'heart_rate', zones, basis, note };
}

/**
 * Choose the best HR methodology the athlete actually has data for,
 * preferring the more physiologically grounded models.
 */
export function selectHeartRateMethodology(
  preferred: ZoneMethodology,
  inputs: HeartRateZoneInputs,
): Extract<ZoneMethodology, 'max_hr_percent' | 'hr_reserve' | 'threshold_hr'> {
  const canThreshold = inputs.thresholdHeartRateBpm !== undefined;
  const canReserve =
    inputs.restingHeartRateBpm !== undefined &&
    inputs.restingHeartRateBpm < inputs.maxHeartRateBpm;

  if (preferred === 'threshold_hr' && canThreshold) return 'threshold_hr';
  if (preferred === 'hr_reserve' && canReserve) return 'hr_reserve';
  if (preferred === 'max_hr_percent') return 'max_hr_percent';

  // Preferred methodology lacks data — fall back down the chain.
  if (canThreshold) return 'threshold_hr';
  if (canReserve) return 'hr_reserve';
  return 'max_hr_percent';
}

/**
 * Pace zones anchored to threshold pace.
 *
 * Multipliers are applied to threshold pace in seconds/km. Because pace is an
 * inverse measure (larger number = slower), zone 1 has the LARGEST bounds.
 * Bounds are stored as [faster, slower] i.e. [lowerBound, upperBound] in the
 * numeric sense where lowerBound is the smaller (faster) seconds/km value.
 */
const PACE_ZONE_DEFINITIONS: readonly {
  number: number;
  name: string;
  purpose: string;
  /** [fastMultiplier, slowMultiplier] applied to threshold pace. */
  multipliers: [number, number];
}[] = [
  { number: 1, name: 'Recovery', purpose: 'Active recovery', multipliers: [1.29, 1.5] },
  { number: 2, name: 'Easy', purpose: 'Aerobic base', multipliers: [1.15, 1.29] },
  { number: 3, name: 'Steady', purpose: 'Aerobic development', multipliers: [1.06, 1.15] },
  { number: 4, name: 'Threshold', purpose: 'Lactate threshold', multipliers: [0.97, 1.06] },
  { number: 5, name: 'Interval', purpose: 'VO₂max development', multipliers: [0.88, 0.97] },
];

export function computePaceZones(
  thresholdPaceSecondsPerKm: number,
  methodology: Extract<ZoneMethodology, 'pace_threshold' | 'pace_vdot'> = 'pace_threshold',
): ZoneSet {
  if (thresholdPaceSecondsPerKm <= 0) {
    throw new Error('computePaceZones: thresholdPaceSecondsPerKm must be positive');
  }

  const zones: Zone[] = PACE_ZONE_DEFINITIONS.map((definition) => ({
    number: definition.number,
    name: definition.name,
    purpose: definition.purpose,
    lowerBound: Math.round(definition.multipliers[0] * thresholdPaceSecondsPerKm),
    upperBound: Math.round(definition.multipliers[1] * thresholdPaceSecondsPerKm),
  }));

  return {
    methodology,
    kind: 'pace',
    zones,
    basis: { thresholdPaceSecondsPerKm },
    note:
      methodology === 'pace_vdot'
        ? 'Derived from your estimated VDOT. Update after a hard effort for best accuracy.'
        : 'Anchored to your estimated threshold pace.',
  };
}

/**
 * Which zone a heart rate falls into. Returns undefined for an HR below zone 1.
 */
export function zoneForHeartRate(zoneSet: ZoneSet, bpm: number): Zone | undefined {
  if (zoneSet.kind !== 'heart_rate') {
    throw new Error('zoneForHeartRate: zone set is not heart-rate based');
  }
  // Walk from the top so the open-ended top zone wins for very high HR.
  for (let i = zoneSet.zones.length - 1; i >= 0; i--) {
    const zone = zoneSet.zones[i]!;
    if (bpm >= zone.lowerBound) return zone;
  }
  return undefined;
}

/** Which pace zone a pace falls into (smaller seconds/km = faster). */
export function zoneForPace(zoneSet: ZoneSet, secondsPerKm: number): Zone | undefined {
  if (zoneSet.kind !== 'pace') {
    throw new Error('zoneForPace: zone set is not pace based');
  }
  for (const zone of zoneSet.zones) {
    if (secondsPerKm >= zone.lowerBound && secondsPerKm < zone.upperBound) return zone;
  }
  // Faster than the fastest zone still counts as the top zone.
  const fastest = zoneSet.zones[zoneSet.zones.length - 1]!;
  if (secondsPerKm < fastest.lowerBound) return fastest;
  return undefined;
}

/**
 * Fraction of a sample stream spent in each zone.
 * Returns an array indexed by zone number − 1, summing to 1 (or all zeros when
 * no usable samples exist).
 */
export function zoneDistribution(
  zoneSet: ZoneSet,
  samples: readonly { offsetSeconds: number; heartRateBpm?: number }[],
): number[] {
  const buckets = new Array<number>(zoneSet.zones.length).fill(0);
  let total = 0;

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    if (sample.heartRateBpm === undefined) continue;
    const next = samples[i + 1];
    // Last sample gets the median gap so a trailing sample isn't weightless.
    const dt = next ? next.offsetSeconds - sample.offsetSeconds : 1;
    if (dt <= 0) continue;

    const zone = zoneForHeartRate(zoneSet, sample.heartRateBpm);
    if (!zone) continue;
    buckets[zone.number - 1] = (buckets[zone.number - 1] ?? 0) + dt;
    total += dt;
  }

  if (total === 0) return buckets;
  return buckets.map((v) => clamp(v / total, 0, 1));
}
