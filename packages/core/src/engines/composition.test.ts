import { describe, expect, it } from 'vitest';

import { netChangeCm, withChanges } from './composition.js';

const reading = (capturedAt: string, valueCm: number) => ({ capturedAt, valueCm });

describe('withChanges', () => {
  it('orders newest first whatever order it was given', () => {
    const result = withChanges([
      reading('2026-06-01T08:00:00.000Z', 88),
      reading('2026-08-01T08:00:00.000Z', 85),
      reading('2026-07-01T08:00:00.000Z', 87),
    ]);

    expect(result.map((r) => r.valueCm)).toEqual([85, 87, 88]);
  });

  it('attaches each reading change from the one before it', () => {
    const result = withChanges([
      reading('2026-06-01T08:00:00.000Z', 88),
      reading('2026-07-01T08:00:00.000Z', 87),
      reading('2026-08-01T08:00:00.000Z', 85),
    ]);

    expect(result[0]?.changeCm).toBeCloseTo(-2, 10);
    expect(result[1]?.changeCm).toBeCloseTo(-1, 10);
  });

  it('leaves the oldest without a change rather than calling it zero', () => {
    const result = withChanges([
      reading('2026-06-01T08:00:00.000Z', 88),
      reading('2026-07-01T08:00:00.000Z', 88),
    ]);

    // A genuine no-change reads as 0 ...
    expect(result[0]?.changeCm).toBe(0);
    // ... and "nothing to compare to" stays absent.
    expect(result[1]?.changeCm).toBeUndefined();
    expect('changeCm' in result[1]!).toBe(false);
  });

  it('gives the oldest row on a page its change from the row behind the page', () => {
    const page = [reading('2026-08-01T08:00:00.000Z', 85), reading('2026-07-01T08:00:00.000Z', 87)];

    // Without the extra row a value's delta would appear or vanish depending
    // on where the page boundary fell.
    const result = withChanges(page, reading('2026-06-01T08:00:00.000Z', 88));

    expect(result[1]?.changeCm).toBeCloseTo(-1, 10);
  });

  it('prefers a real neighbour over the supplied one', () => {
    const result = withChanges(
      [reading('2026-08-01T08:00:00.000Z', 85), reading('2026-07-01T08:00:00.000Z', 87)],
      reading('2026-01-01T08:00:00.000Z', 100),
    );

    expect(result[0]?.changeCm).toBeCloseTo(-2, 10);
  });

  it('carries the caller extra fields through untouched', () => {
    const result = withChanges([
      { ...reading('2026-08-01T08:00:00.000Z', 85), sessionId: 's-1', recordedUnit: 'in' },
    ]);

    expect(result[0]).toMatchObject({ sessionId: 's-1', recordedUnit: 'in' });
  });

  it('handles the empty and single cases', () => {
    expect(withChanges([])).toEqual([]);

    const single = withChanges([reading('2026-08-01T08:00:00.000Z', 85)]);
    expect(single).toHaveLength(1);
    expect(single[0]?.changeCm).toBeUndefined();
  });

  it('does not mutate the array it was given', () => {
    const input = [
      reading('2026-06-01T08:00:00.000Z', 88),
      reading('2026-08-01T08:00:00.000Z', 85),
    ];
    withChanges(input);

    expect(input.map((r) => r.valueCm)).toEqual([88, 85]);
  });
});

describe('netChangeCm', () => {
  it('measures oldest to newest regardless of input order', () => {
    expect(
      netChangeCm([
        reading('2026-08-01T08:00:00.000Z', 85),
        reading('2026-06-01T08:00:00.000Z', 88),
      ]),
    ).toBeCloseTo(-3, 10);
  });

  it('refuses to call a single reading a direction', () => {
    // One measurement is a position, not a trend.
    expect(netChangeCm([reading('2026-08-01T08:00:00.000Z', 85)])).toBeUndefined();
    expect(netChangeCm([])).toBeUndefined();
  });
});
