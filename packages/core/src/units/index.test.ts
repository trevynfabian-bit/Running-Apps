import { describe, expect, it } from 'vitest';
import {
  computePace,
  formatDistance,
  formatDuration,
  formatPace,
  paceToSpeed,
  parseDuration,
  speedToPace,
} from './index.js';

describe('pace and speed', () => {
  it('round-trips between pace and speed', () => {
    const pace = 300; // 5:00/km
    const speed = paceToSpeed(pace)!;
    expect(speedToPace(speed)).toBeCloseTo(pace, 6);
  });

  it('computes pace from distance and duration', () => {
    // 10 km in 50:00 = 5:00/km.
    expect(computePace(10000, 3000)).toBeCloseTo(300, 6);
  });

  it('refuses to divide by zero', () => {
    expect(computePace(0, 3000)).toBeUndefined();
    expect(computePace(10000, 0)).toBeUndefined();
    expect(speedToPace(0)).toBeUndefined();
    expect(paceToSpeed(0)).toBeUndefined();
  });
});

describe('formatDuration', () => {
  it('formats under an hour as M:SS', () => {
    expect(formatDuration(2702)).toBe('45:02');
    expect(formatDuration(59)).toBe('0:59');
  });

  it('formats over an hour as H:MM:SS', () => {
    expect(formatDuration(6900)).toBe('1:55:00');
  });

  it('can force hours for alignment', () => {
    expect(formatDuration(2702, true)).toBe('0:45:02');
  });

  it('clamps a negative duration to zero rather than showing nonsense', () => {
    expect(formatDuration(-5)).toBe('0:00');
  });
});

describe('formatPace', () => {
  it('formats metric pace', () => {
    expect(formatPace(300)).toBe('5:00/km');
    expect(formatPace(371)).toBe('6:11/km');
  });

  it('converts to imperial when asked', () => {
    // 5:00/km is about 8:03/mi.
    expect(formatPace(300, 'imperial')).toBe('8:03/mi');
  });

  it('shows a dash rather than Infinity for a zero pace', () => {
    expect(formatPace(0)).toBe('—');
    expect(formatPace(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatDistance', () => {
  it('uses metres below a kilometre', () => {
    expect(formatDistance(800)).toBe('800 m');
  });

  it('uses two decimals for short distances and one for long', () => {
    expect(formatDistance(7120)).toBe('7.12 km');
    expect(formatDistance(21097.5)).toBe('21.1 km');
  });

  it('converts to miles', () => {
    expect(formatDistance(1609.344, 'imperial')).toBe('1.00 mi');
  });
});

describe('parseDuration', () => {
  it('parses M:SS and H:MM:SS', () => {
    expect(parseDuration('45:02')).toBe(2702);
    expect(parseDuration('1:55:00')).toBe(6900);
  });

  it('rejects malformed input rather than guessing', () => {
    expect(parseDuration('abc')).toBeUndefined();
    expect(parseDuration('')).toBeUndefined();
    expect(parseDuration('1:2:3:4')).toBeUndefined();
    // 75 seconds is not a valid seconds field.
    expect(parseDuration('5:75')).toBeUndefined();
    expect(parseDuration('1:75:00')).toBeUndefined();
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseDuration('  45:02  ')).toBe(2702);
  });
});
