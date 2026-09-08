/**
 * Time helpers.
 *
 * Invariant for the whole system: everything is stored and computed in UTC.
 * Localisation happens only at the presentation edge, using the athlete's
 * IANA timezone. A "training day" is therefore not a UTC calendar day — it is
 * the calendar day in the athlete's own timezone, which is what matters when
 * deciding whether a 23:40 run belongs to Tuesday or Wednesday.
 */

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

/** A calendar day in the athlete's local timezone, as `YYYY-MM-DD`. */
export type LocalDate = string;

/**
 * Resolve the local calendar date for an instant in a given IANA timezone.
 *
 * Uses Intl rather than manual offset maths so DST transitions are handled by
 * the platform's tz database instead of by us.
 */
export function toLocalDate(instant: Date, timeZone: string): LocalDate {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA formats as YYYY-MM-DD, which is exactly the shape we want.
  return fmt.format(instant);
}

/** Local wall-clock hour (0-23) of an instant in a timezone. */
export function localHour(instant: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  });
  return Number.parseInt(fmt.format(instant), 10);
}

/** Day of week in the athlete's timezone. 0 = Sunday .. 6 = Saturday. */
export function localDayOfWeek(instant: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' });
  const name = fmt.format(instant);
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
  return index === -1 ? instant.getUTCDay() : index;
}

/** Add whole days to a `YYYY-MM-DD` string without timezone drift. */
export function addDaysToLocalDate(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  // Anchor at UTC noon so ±1 day arithmetic can never cross a date boundary
  // through a DST-induced hour shift.
  const anchor = new Date(Date.UTC(y, m - 1, d, 12));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (b - a). Negative when b precedes a. */
export function daysBetweenLocalDates(a: LocalDate, b: LocalDate): number {
  const parse = (s: LocalDate): number => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(b) - parse(a)) / MS_PER_DAY);
}

/**
 * The Monday-anchored week start for a local date.
 * Running weeks conventionally run Monday→Sunday so the long run lands at the
 * end of the week rather than splitting it.
 */
export function startOfWeek(date: LocalDate): LocalDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const anchor = new Date(Date.UTC(y, m - 1, d, 12));
  const dow = anchor.getUTCDay(); // 0 = Sunday
  const shift = dow === 0 ? -6 : 1 - dow;
  return addDaysToLocalDate(date, shift);
}

/** ISO-8601 week key, e.g. `2026-W33`. Stable sort key for weekly rollups. */
export function isoWeekKey(date: LocalDate): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const anchor = new Date(Date.UTC(y, m - 1, d));
  // ISO weeks are defined by the Thursday of the week.
  const dayNum = (anchor.getUTCDay() + 6) % 7;
  anchor.setUTCDate(anchor.getUTCDate() - dayNum + 3);
  const isoYear = anchor.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((anchor.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** Inclusive list of local dates from `from` to `to`. */
export function localDateRange(from: LocalDate, to: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  const span = daysBetweenLocalDates(from, to);
  if (span < 0) return out;
  for (let i = 0; i <= span; i++) out.push(addDaysToLocalDate(from, i));
  return out;
}

/** Absolute difference between two instants, in seconds. */
export function absSecondsBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / MS_PER_SECOND;
}

/** True when the two intervals overlap by at least one millisecond. */
export function intervalsOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

/** Overlap duration of two intervals in seconds (0 when disjoint). */
export function overlapSeconds(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): number {
  const start = Math.max(aStart.getTime(), bStart.getTime());
  const end = Math.min(aEnd.getTime(), bEnd.getTime());
  return Math.max(0, (end - start) / MS_PER_SECOND);
}
