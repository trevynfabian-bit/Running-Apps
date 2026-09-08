import { describe, expect, it } from 'vitest';
import {
  addDaysToLocalDate,
  daysBetweenLocalDates,
  isoWeekKey,
  localDateRange,
  localDayOfWeek,
  overlapSeconds,
  startOfWeek,
  toLocalDate,
} from './time.js';

describe('toLocalDate', () => {
  it('resolves the athlete-local day, not the UTC day', () => {
    // 23:40 in Jakarta (UTC+7) on the 11th is 16:40Z on the 11th.
    const instant = new Date('2026-08-11T16:40:00Z');
    expect(toLocalDate(instant, 'Asia/Jakarta')).toBe('2026-08-11');
    expect(toLocalDate(instant, 'UTC')).toBe('2026-08-11');
  });

  it('attributes a late-night run to the correct local day across the date line', () => {
    // 00:30 Jakarta on the 12th is 17:30Z on the 11th.
    const instant = new Date('2026-08-11T17:30:00Z');
    expect(toLocalDate(instant, 'Asia/Jakarta')).toBe('2026-08-12');
    expect(toLocalDate(instant, 'UTC')).toBe('2026-08-11');
  });

  it('handles a timezone behind UTC', () => {
    // 20:00 in Los Angeles (UTC-7 in August) on the 11th is 03:00Z on the 12th.
    const instant = new Date('2026-08-12T03:00:00Z');
    expect(toLocalDate(instant, 'America/Los_Angeles')).toBe('2026-08-11');
  });
});

describe('addDaysToLocalDate', () => {
  it('adds and subtracts days', () => {
    expect(addDaysToLocalDate('2026-08-11', 1)).toBe('2026-08-12');
    expect(addDaysToLocalDate('2026-08-11', -1)).toBe('2026-08-10');
  });

  it('crosses month boundaries', () => {
    expect(addDaysToLocalDate('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDaysToLocalDate('2026-09-01', -1)).toBe('2026-08-31');
  });

  it('crosses year boundaries', () => {
    expect(addDaysToLocalDate('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('handles a leap day', () => {
    expect(addDaysToLocalDate('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDaysToLocalDate('2028-02-29', 1)).toBe('2028-03-01');
  });

  it('does not drift across a DST transition', () => {
    // US DST starts 2026-03-08. Anchoring at UTC noon avoids an hour shift
    // silently rolling the date back or forward.
    expect(addDaysToLocalDate('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDaysToLocalDate('2026-03-08', 1)).toBe('2026-03-09');
  });
});

describe('daysBetweenLocalDates', () => {
  it('counts forward and backward', () => {
    expect(daysBetweenLocalDates('2026-08-11', '2026-08-18')).toBe(7);
    expect(daysBetweenLocalDates('2026-08-18', '2026-08-11')).toBe(-7);
    expect(daysBetweenLocalDates('2026-08-11', '2026-08-11')).toBe(0);
  });

  it('counts correctly across a DST boundary', () => {
    expect(daysBetweenLocalDates('2026-03-01', '2026-03-31')).toBe(30);
  });
});

describe('startOfWeek', () => {
  it('anchors weeks to Monday', () => {
    // 2026-08-18 is a Tuesday.
    expect(startOfWeek('2026-08-18')).toBe('2026-08-17');
  });

  it('treats Sunday as the end of the week, not the start', () => {
    // 2026-08-23 is a Sunday; its week began Monday the 17th.
    expect(startOfWeek('2026-08-23')).toBe('2026-08-17');
  });

  it('is idempotent on a Monday', () => {
    expect(startOfWeek('2026-08-17')).toBe('2026-08-17');
  });
});

describe('isoWeekKey', () => {
  it('produces a sortable key', () => {
    expect(isoWeekKey('2026-08-18')).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('gives the same key to every day of one week', () => {
    const monday = isoWeekKey('2026-08-17');
    const sunday = isoWeekKey('2026-08-23');
    expect(monday).toBe(sunday);
  });

  it('gives different keys to adjacent weeks', () => {
    expect(isoWeekKey('2026-08-17')).not.toBe(isoWeekKey('2026-08-24'));
  });
});

describe('localDateRange', () => {
  it('is inclusive at both ends', () => {
    const range = localDateRange('2026-08-11', '2026-08-14');
    expect(range).toEqual(['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']);
  });

  it('returns empty for an inverted range', () => {
    expect(localDateRange('2026-08-14', '2026-08-11')).toEqual([]);
  });
});

describe('localDayOfWeek', () => {
  it('reports the day in the athlete timezone', () => {
    // 2026-08-17 is a Monday.
    expect(localDayOfWeek(new Date('2026-08-17T04:00:00Z'), 'Asia/Jakarta')).toBe(1);
  });
});

describe('overlapSeconds', () => {
  it('measures the intersection of two intervals', () => {
    const overlap = overlapSeconds(
      new Date('2026-08-11T02:00:00Z'),
      new Date('2026-08-11T03:00:00Z'),
      new Date('2026-08-11T02:30:00Z'),
      new Date('2026-08-11T03:30:00Z'),
    );
    expect(overlap).toBe(1800);
  });

  it('returns zero for disjoint intervals', () => {
    const overlap = overlapSeconds(
      new Date('2026-08-11T02:00:00Z'),
      new Date('2026-08-11T03:00:00Z'),
      new Date('2026-08-11T04:00:00Z'),
      new Date('2026-08-11T05:00:00Z'),
    );
    expect(overlap).toBe(0);
  });
});
