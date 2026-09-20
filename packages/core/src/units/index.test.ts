import { describe, expect, it } from 'vitest';
import {
  computePace,
  convertLength,
  formatCanonicalLength,
  formatDistance,
  formatDuration,
  formatLength,
  formatSignedLength,
  formatPace,
  fromCanonicalLength,
  paceToSpeed,
  parseDuration,
  parseLength,
  speedToPace,
  toCanonicalLength,
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

describe('circumference length', () => {
  it('round-trips between centimetres and inches', () => {
    const cm = 86.4;
    expect(convertLength(convertLength(cm, 'cm', 'in'), 'in', 'cm')).toBeCloseTo(cm, 10);
  });

  it('converts using the exact inch definition', () => {
    expect(convertLength(1, 'in', 'cm')).toBe(2.54);
    expect(convertLength(2.54, 'cm', 'in')).toBeCloseTo(1, 10);
  });

  it('is a no-op when the units match', () => {
    expect(convertLength(73.5, 'cm', 'cm')).toBe(73.5);
    expect(convertLength(29, 'in', 'in')).toBe(29);
  });

  it('stores in centimetres whichever unit was typed', () => {
    expect(toCanonicalLength(34, 'in')).toBeCloseTo(86.36, 10);
    expect(toCanonicalLength(86.36, 'cm')).toBe(86.36);
    expect(fromCanonicalLength(86.36, 'in')).toBeCloseTo(34, 10);
  });

  it('formats to one decimal in the requested unit', () => {
    expect(formatLength(86.4, 'cm')).toBe('86.4 cm');
    expect(formatLength(34, 'in')).toBe('34.0 in');
    expect(formatCanonicalLength(86.36, 'in')).toBe('34.0 in');
    expect(formatCanonicalLength(86.36, 'cm')).toBe('86.4 cm');
  });

  it('shows a placeholder rather than a nonsense number', () => {
    expect(formatLength(Number.NaN, 'cm')).toBe('—');
    expect(formatLength(-1, 'cm')).toBe('—');
  });

  it('parses a typed value with either decimal separator', () => {
    expect(parseLength('86.4')).toBe(86.4);
    expect(parseLength('86,4')).toBe(86.4);
    expect(parseLength(' 34 ')).toBe(34);
    expect(parseLength('.5')).toBe(0.5);
  });

  it('rejects input that is not a measurable circumference', () => {
    expect(parseLength('')).toBeUndefined();
    expect(parseLength('abc')).toBeUndefined();
    expect(parseLength('0')).toBeUndefined();
    expect(parseLength('-5')).toBeUndefined();
    expect(parseLength('8.6.4')).toBeUndefined();
    expect(parseLength('12cm')).toBeUndefined();
  });
});

describe('formatSignedLength', () => {
  it('signs the change and keeps one decimal', () => {
    expect(formatSignedLength(-1.1, 'cm')).toBe('\u22121.1 cm');
    expect(formatSignedLength(0.3, 'cm')).toBe('+0.3 cm');
  });

  it('renders the delta in the requested unit', () => {
    // 2.54 cm is exactly one inch, in either direction.
    expect(formatSignedLength(2.54, 'in')).toBe('+1.0 in');
    expect(formatSignedLength(-2.54, 'in')).toBe('\u22121.0 in');
  });

  it('shows an unsigned zero for a change too small to have a direction', () => {
    expect(formatSignedLength(0, 'cm')).toBe('0.0 cm');
    expect(formatSignedLength(-0.02, 'cm')).toBe('0.0 cm');
  });

  it('defaults to centimetres', () => {
    expect(formatSignedLength(-1.1)).toBe('\u22121.1 cm');
  });

  it('shows a placeholder for a non-finite delta', () => {
    expect(formatSignedLength(Number.NaN, 'cm')).toBe('—');
  });
});
