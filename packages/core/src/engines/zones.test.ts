import { describe, expect, it } from 'vitest';
import {
  computeHeartRateZones,
  computePaceZones,
  selectHeartRateMethodology,
  zoneDistribution,
  zoneForHeartRate,
  zoneForPace,
} from './zones.js';

describe('computeHeartRateZones', () => {
  it('produces five contiguous, ascending zones', () => {
    const set = computeHeartRateZones('max_hr_percent', { maxHeartRateBpm: 190 });
    expect(set.zones).toHaveLength(5);

    for (let i = 1; i < set.zones.length; i++) {
      expect(set.zones[i]!.lowerBound).toBeGreaterThan(set.zones[i - 1]!.lowerBound);
    }
    // The top zone is open-ended so an athlete can exceed their estimated max.
    expect(set.zones[4]!.upperBound).toBe(Number.POSITIVE_INFINITY);
  });

  it('gives different boundaries for %max and heart-rate reserve', () => {
    const byMax = computeHeartRateZones('max_hr_percent', { maxHeartRateBpm: 190 });
    const byReserve = computeHeartRateZones('hr_reserve', {
      maxHeartRateBpm: 190,
      restingHeartRateBpm: 48,
    });

    // This is the whole reason methodologies must never be mixed: the same
    // "Zone 2" label denotes a materially different intensity.
    expect(byMax.zones[1]!.lowerBound).not.toBe(byReserve.zones[1]!.lowerBound);
    expect(byMax.methodology).toBe('max_hr_percent');
    expect(byReserve.methodology).toBe('hr_reserve');
  });

  it('accounts for resting heart rate under Karvonen', () => {
    const lowResting = computeHeartRateZones('hr_reserve', {
      maxHeartRateBpm: 190,
      restingHeartRateBpm: 40,
    });
    const highResting = computeHeartRateZones('hr_reserve', {
      maxHeartRateBpm: 190,
      restingHeartRateBpm: 70,
    });
    expect(highResting.zones[1]!.lowerBound).toBeGreaterThan(lowResting.zones[1]!.lowerBound);
  });

  it('refuses to compute Karvonen zones without a resting heart rate', () => {
    expect(() => computeHeartRateZones('hr_reserve', { maxHeartRateBpm: 190 })).toThrow(
      /restingHeartRateBpm/,
    );
  });

  it('refuses nonsensical inputs', () => {
    expect(() => computeHeartRateZones('max_hr_percent', { maxHeartRateBpm: 0 })).toThrow();
    expect(() =>
      computeHeartRateZones('hr_reserve', { maxHeartRateBpm: 150, restingHeartRateBpm: 160 }),
    ).toThrow(/resting HR must be below max/);
  });

  it('records the anchors it used', () => {
    const set = computeHeartRateZones('threshold_hr', {
      maxHeartRateBpm: 190,
      thresholdHeartRateBpm: 172,
    });
    expect(set.basis.thresholdHeartRateBpm).toBe(172);
    expect(set.note).toBeDefined();
  });
});

describe('selectHeartRateMethodology', () => {
  it('honours the preference when the data supports it', () => {
    expect(
      selectHeartRateMethodology('hr_reserve', {
        maxHeartRateBpm: 190,
        restingHeartRateBpm: 48,
      }),
    ).toBe('hr_reserve');
  });

  it('falls back gracefully when the preferred anchor is missing', () => {
    // Wants Karvonen but has no resting HR, and no threshold either.
    expect(selectHeartRateMethodology('hr_reserve', { maxHeartRateBpm: 190 })).toBe(
      'max_hr_percent',
    );
  });

  it('prefers threshold when available even if another was requested', () => {
    expect(
      selectHeartRateMethodology('hr_reserve', {
        maxHeartRateBpm: 190,
        thresholdHeartRateBpm: 172,
      }),
    ).toBe('threshold_hr');
  });
});

describe('zoneForHeartRate', () => {
  const set = computeHeartRateZones('max_hr_percent', { maxHeartRateBpm: 190 });

  it('places a heart rate into the right zone', () => {
    // 0.6-0.7 of 190 = 114-133 => zone 2.
    expect(zoneForHeartRate(set, 125)!.number).toBe(2);
  });

  it('puts a heart rate above max into the top zone rather than nowhere', () => {
    expect(zoneForHeartRate(set, 200)!.number).toBe(5);
  });

  it('returns undefined below zone 1', () => {
    expect(zoneForHeartRate(set, 60)).toBeUndefined();
  });

  it('throws when given a pace zone set', () => {
    const paceSet = computePaceZones(300);
    expect(() => zoneForHeartRate(paceSet, 140)).toThrow(/not heart-rate based/);
  });
});

describe('computePaceZones', () => {
  it('orders zones from slowest to fastest', () => {
    const set = computePaceZones(300); // 5:00/km threshold
    // Zone 1 (recovery) is the SLOWEST, so the largest seconds/km.
    expect(set.zones[0]!.lowerBound).toBeGreaterThan(set.zones[4]!.lowerBound);
  });

  it('puts threshold pace inside the threshold zone', () => {
    const set = computePaceZones(300);
    const zone = zoneForPace(set, 300);
    expect(zone!.number).toBe(4);
  });

  it('classifies a very fast pace into the top zone', () => {
    const set = computePaceZones(300);
    expect(zoneForPace(set, 200)!.number).toBe(5);
  });

  it('rejects a non-positive threshold pace', () => {
    expect(() => computePaceZones(0)).toThrow();
  });
});

describe('zoneDistribution', () => {
  const set = computeHeartRateZones('max_hr_percent', { maxHeartRateBpm: 190 });

  it('sums to one for a valid stream', () => {
    const samples = [
      { offsetSeconds: 0, heartRateBpm: 125 },
      { offsetSeconds: 60, heartRateBpm: 125 },
      { offsetSeconds: 120, heartRateBpm: 160 },
      { offsetSeconds: 180, heartRateBpm: 160 },
    ];
    const distribution = zoneDistribution(set, samples);
    const total = distribution.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('returns all zeros when no samples carry heart rate', () => {
    const distribution = zoneDistribution(set, [
      { offsetSeconds: 0 },
      { offsetSeconds: 60 },
    ]);
    expect(distribution.every((v) => v === 0)).toBe(true);
  });

  it('handles an empty stream without throwing', () => {
    expect(() => zoneDistribution(set, [])).not.toThrow();
  });
});
