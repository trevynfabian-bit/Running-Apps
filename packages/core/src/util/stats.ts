/**
 * Small statistics helpers used across the performance engines.
 *
 * Everything here is total: an empty input never throws, it returns `undefined`
 * (or a neutral value where that is unambiguous). Training data is sparse and
 * the engines must degrade rather than crash when an athlete has a thin history.
 */

export function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/** Population standard deviation. Returns 0 for a single sample. */
export function stdDev(values: readonly number[]): number | undefined {
  const m = mean(values);
  if (m === undefined) return undefined;
  if (values.length === 1) return 0;
  let acc = 0;
  for (const v of values) acc += (v - m) ** 2;
  return Math.sqrt(acc / values.length);
}

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Exponentially weighted moving average over an ordered series (oldest first).
 *
 * Used for chronic/acute training load, where an exponential decay models
 * "recent work counts more" better than a hard-edged rolling window.
 *
 * @param timeConstantDays the load half-life expressed as a time constant N;
 *        alpha = 2 / (N + 1), matching the conventional EWMA formulation.
 */
export function ewma(values: readonly number[], timeConstantDays: number): number | undefined {
  if (values.length === 0) return undefined;
  if (timeConstantDays <= 0) return values[values.length - 1];
  const alpha = 2 / (timeConstantDays + 1);
  let acc = values[0]!;
  for (let i = 1; i < values.length; i++) {
    acc = alpha * values[i]! + (1 - alpha) * acc;
  }
  return acc;
}

/** Ordinary least squares fit of y over x. Returns undefined if degenerate. */
export function linearRegression(
  points: readonly { x: number; y: number }[],
): { slope: number; intercept: number; r2: number } | undefined {
  const n = points.length;
  if (n < 2) return undefined;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const mx = mean(xs)!;
  const my = mean(ys)!;

  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  // All x identical: no slope is defined.
  if (den === 0) return undefined;

  const slope = num / den;
  const intercept = my - slope * mx;

  let ssRes = 0;
  let ssTot = 0;
  for (const p of points) {
    const predicted = slope * p.x + intercept;
    ssRes += (p.y - predicted) ** 2;
    ssTot += (p.y - my) ** 2;
  }
  // A perfectly flat y series has no variance to explain; call that r2 = 1
  // when the fit is exact, else 0.
  const r2 = ssTot === 0 ? (ssRes === 0 ? 1 : 0) : 1 - ssRes / ssTot;

  return { slope, intercept, r2 };
}

/** Clamp a number into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Linear interpolation between a and b at t in [0, 1]. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

/**
 * Map a value from one range onto another, clamped at both ends.
 * Used constantly for turning raw physiological signals into 0..100 sub-scores.
 */
export function scaleClamped(
  value: number,
  fromLow: number,
  fromHigh: number,
  toLow: number,
  toHigh: number,
): number {
  if (fromHigh === fromLow) return toLow;
  const t = (value - fromLow) / (fromHigh - fromLow);
  return clamp(toLow + t * (toHigh - toLow), Math.min(toLow, toHigh), Math.max(toLow, toHigh));
}

/** Percentage change from `from` to `to`. Undefined when `from` is 0. */
export function percentChange(from: number, to: number): number | undefined {
  if (from === 0) return undefined;
  return ((to - from) / Math.abs(from)) * 100;
}

/** Round to a fixed number of decimal places (avoids float display noise). */
export function round(value: number, decimals = 0): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Coefficient of variation (stdDev / mean), a unitless consistency measure. */
export function coefficientOfVariation(values: readonly number[]): number | undefined {
  const m = mean(values);
  const sd = stdDev(values);
  if (m === undefined || sd === undefined || m === 0) return undefined;
  return sd / Math.abs(m);
}

/** Filter out null/undefined in a type-safe way. */
export function compact<T>(values: readonly (T | null | undefined)[]): T[] {
  return values.filter((v): v is T => v !== null && v !== undefined);
}
