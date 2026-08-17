import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEDUP_CONFIG,
  clusterWorkouts,
  computeSourceConfidence,
  deduplicateWorkouts,
  haversineMeters,
  mergeCluster,
  similarity,
} from './dedup.js';
import { makeProviderWorkout, TEST_TZ } from '../__fixtures__/index.js';

describe('dedup: the three-provider scenario', () => {
  // The canonical case from the product spec: one run, seen by three services,
  // each with slightly different clipping and GPS processing.
  const strava = makeProviderWorkout({
    provider: 'strava',
    externalId: 's-100',
    startTime: new Date('2026-08-11T02:00:00Z'),
    durationSeconds: 2702, // 45:02
    distanceMeters: 7120,
    avgHeartRateBpm: 148,
  });

  const whoop = makeProviderWorkout({
    provider: 'whoop',
    externalId: 'w-100',
    startTime: new Date('2026-08-11T02:01:00Z'),
    durationSeconds: 2699, // 44:59
    distanceMeters: 7100,
    avgHeartRateBpm: 149,
  });

  const healthkit = makeProviderWorkout({
    provider: 'healthkit',
    externalId: 'h-100',
    startTime: new Date('2026-08-11T02:00:00Z'),
    durationSeconds: 2703, // 45:03
    distanceMeters: 7110,
    avgHeartRateBpm: 147,
  });

  it('collapses all three into a single canonical workout', () => {
    const clusters = clusterWorkouts([strava, whoop, healthkit]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(3);
  });

  it('records every contributing provider on the merged record', () => {
    const [merged] = deduplicateWorkouts([strava, whoop, healthkit], {
      idFor: () => 'canonical-1',
      defaultTimezone: TEST_TZ,
    });

    expect(merged!.sourceRecords.map((s) => s.provider).sort()).toEqual([
      'healthkit',
      'strava',
      'whoop',
    ]);
  });

  it('takes distance from Strava and heart rate from WHOOP', () => {
    const merged = mergeCluster([strava, whoop, healthkit], {
      id: 'c-1',
      defaultTimezone: TEST_TZ,
    });

    // Strava is the most trusted source for GPS distance.
    expect(merged.distanceMeters).toBe(7120);
    // WHOOP is the most trusted source for heart rate.
    expect(merged.avgHeartRateBpm).toBe(149);

    const stravaRef = merged.sourceRecords.find((s) => s.provider === 'strava')!;
    const whoopRef = merged.sourceRecords.find((s) => s.provider === 'whoop')!;
    expect(stravaRef.contributedFields).toContain('distanceMeters');
    expect(whoopRef.contributedFields).toContain('avgHeartRateBpm');
  });

  it('spans the union of the reported time windows', () => {
    const merged = mergeCluster([strava, whoop, healthkit], {
      id: 'c-1',
      defaultTimezone: TEST_TZ,
    });
    // Earliest start across providers.
    expect(merged.startTime.toISOString()).toBe('2026-08-11T02:00:00.000Z');
  });

  it('raises source confidence when providers corroborate', () => {
    const alone = computeSourceConfidence([strava]);
    const together = computeSourceConfidence([strava, whoop, healthkit]);
    expect(together).toBeGreaterThan(alone);
    expect(together).toBeLessThanOrEqual(1);
  });
});

describe('dedup: rejects genuinely distinct sessions', () => {
  it('keeps a double day as two workouts', () => {
    const morning = makeProviderWorkout({
      provider: 'strava',
      externalId: 's-1',
      startTime: new Date('2026-08-11T00:00:00Z'),
      durationSeconds: 2400,
      distanceMeters: 6000,
    });
    const evening = makeProviderWorkout({
      provider: 'whoop',
      externalId: 'w-1',
      startTime: new Date('2026-08-11T11:00:00Z'),
      durationSeconds: 2400,
      distanceMeters: 6000,
    });

    const clusters = clusterWorkouts([morning, evening]);
    expect(clusters).toHaveLength(2);
  });

  it('never merges two records from the same provider', () => {
    const a = makeProviderWorkout({ provider: 'strava', externalId: 's-1' });
    const b = makeProviderWorkout({ provider: 'strava', externalId: 's-2' });

    const result = similarity(a, b);
    expect(result.rejected).toBe(true);
    expect(result.rejectionReason).toBe('same_provider');
    expect(clusterWorkouts([a, b])).toHaveLength(2);
  });

  it('refuses to merge across different sports', () => {
    const run = makeProviderWorkout({ provider: 'strava', externalId: 's-1', sport: 'run' });
    const ride = makeProviderWorkout({ provider: 'whoop', externalId: 'w-1', sport: 'ride' });

    const result = similarity(run, ride);
    expect(result.rejected).toBe(true);
    expect(result.rejectionReason).toBe('sport_mismatch');
  });

  it('rejects when distance differs beyond tolerance', () => {
    const short = makeProviderWorkout({
      provider: 'strava',
      externalId: 's-1',
      distanceMeters: 5000,
    });
    const long = makeProviderWorkout({
      provider: 'whoop',
      externalId: 'w-1',
      distanceMeters: 9000,
    });

    const result = similarity(short, long);
    expect(result.rejected).toBe(true);
    expect(result.rejectionReason).toBe('distance_mismatch');
  });

  it('rejects when start times are far apart even if everything else matches', () => {
    const a = makeProviderWorkout({
      provider: 'strava',
      externalId: 's-1',
      startTime: new Date('2026-08-11T02:00:00Z'),
    });
    const b = makeProviderWorkout({
      provider: 'whoop',
      externalId: 'w-1',
      startTime: new Date('2026-08-11T02:30:00Z'),
    });

    const result = similarity(a, b);
    expect(result.rejected).toBe(true);
    expect(result.rejectionReason).toBe('start_time_too_far');
  });
});

describe('dedup: edge cases', () => {
  it('handles a workout with no heart rate at all', () => {
    const a = makeProviderWorkout({
      provider: 'strava',
      externalId: 's-1',
      avgHeartRateBpm: undefined,
    });
    const b = makeProviderWorkout({
      provider: 'healthkit',
      externalId: 'h-1',
      avgHeartRateBpm: undefined,
    });

    const clusters = clusterWorkouts([a, b]);
    expect(clusters).toHaveLength(1);

    const merged = mergeCluster(clusters[0]!, { id: 'c-1', defaultTimezone: TEST_TZ });
    expect(merged.avgHeartRateBpm).toBeUndefined();
    // Still a usable record — just with lower confidence.
    expect(merged.sourceConfidence).toBeGreaterThan(0);
  });

  it('handles a single manual workout with no distance', () => {
    const manual = makeProviderWorkout({
      provider: 'manual',
      externalId: 'm-1',
      distanceMeters: undefined,
      avgHeartRateBpm: undefined,
      perceivedExertion: 5,
    });

    const merged = mergeCluster([manual], { id: 'c-1', defaultTimezone: TEST_TZ });
    expect(merged.distanceMeters).toBeUndefined();
    expect(merged.avgPaceSecondsPerKm).toBeUndefined();
    expect(merged.perceivedExertion).toBe(5);
  });

  it('handles a workout crossing midnight in the athlete timezone', () => {
    // 23:40 local Jakarta (UTC+7) on the 11th = 16:40Z on the 11th.
    const late = makeProviderWorkout({
      provider: 'strava',
      externalId: 's-1',
      startTime: new Date('2026-08-11T16:40:00Z'),
      durationSeconds: 3600,
    });

    const merged = mergeCluster([late], { id: 'c-1', defaultTimezone: TEST_TZ });
    // The record spans midnight but remains one coherent workout.
    expect(merged.endTime.getTime() - merged.startTime.getTime()).toBe(3600 * 1000);
    expect(merged.timezone).toBe(TEST_TZ);
  });

  it('is order-independent', () => {
    const a = makeProviderWorkout({ provider: 'strava', externalId: 's-1' });
    const b = makeProviderWorkout({ provider: 'whoop', externalId: 'w-1' });
    const c = makeProviderWorkout({ provider: 'healthkit', externalId: 'h-1' });

    const forward = clusterWorkouts([a, b, c]);
    const backward = clusterWorkouts([c, b, a]);
    expect(forward).toHaveLength(backward.length);
    expect(forward[0]!.length).toBe(backward[0]!.length);
  });

  it('throws rather than silently returning garbage for an empty cluster', () => {
    expect(() => mergeCluster([], { id: 'x', defaultTimezone: TEST_TZ })).toThrow();
  });

  it('matches an auto-detected activity that clipped the warm-up', () => {
    // WHOOP frequently starts a few minutes late and reports less distance.
    const strava = makeProviderWorkout({
      provider: 'strava',
      externalId: 's-1',
      startTime: new Date('2026-08-11T02:00:00Z'),
      durationSeconds: 3600,
      distanceMeters: 10_000,
    });
    const whoopClipped = makeProviderWorkout({
      provider: 'whoop',
      externalId: 'w-1',
      startTime: new Date('2026-08-11T02:04:00Z'),
      durationSeconds: 3380,
      distanceMeters: 9400,
    });

    const result = similarity(strava, whoopClipped);
    expect(result.rejected).toBe(false);
    expect(result.score).toBeGreaterThanOrEqual(DEFAULT_DEDUP_CONFIG.matchThreshold);
  });
});

describe('haversineMeters', () => {
  it('returns zero for identical points', () => {
    expect(haversineMeters({ lat: -6.2, lon: 106.8 }, { lat: -6.2, lon: 106.8 })).toBe(0);
  });

  it('computes a known distance to within 1%', () => {
    // ~111.2 km per degree of latitude at the equator.
    const meters = haversineMeters({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    expect(meters).toBeGreaterThan(110_000);
    expect(meters).toBeLessThan(112_000);
  });
});
