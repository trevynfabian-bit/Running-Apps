/**
 * Body composition calculations.
 *
 * Pure and deterministic like the rest of the engines: no clock, no ids
 * generated here, no I/O. Both the API and the mobile app compute a measure
 * point's history through this, so the number an athlete sees on their phone
 * and the number the server reports are the same number by construction rather
 * than by two implementations agreeing for now.
 */

/** The minimum a value needs to carry for a change to be computed from it. */
export interface CompositionReading {
  /** When the session it belongs to was taken. ISO-8601. */
  capturedAt: string;
  /** Canonical centimetres. Deltas are meaningless in mixed units. */
  valueCm: number;
}

export type WithChange<T> = T & {
  /**
   * Change in centimetres from the next-older reading. Undefined when there is
   * no older reading to compare against — which is not the same as a change of
   * exactly zero, and the two must stay distinguishable.
   */
  changeCm?: number;
};

/**
 * Order readings newest-first and attach each one's change from the reading
 * before it.
 *
 * Sorting here rather than trusting the caller: the API orders in SQL, the app
 * concatenates an in-progress session onto a fetched list, and a delta computed
 * against the wrong neighbour is wrong in a way nothing downstream can detect.
 *
 * `olderNeighbour` exists for pagination. A page of ten readings has an
 * eleventh behind it, and the oldest row *on the page* still deserves its
 * change — otherwise a value's delta would appear and disappear depending on
 * where the page boundary happened to fall. Callers fetch one extra row and
 * pass it here.
 */
export function withChanges<T extends CompositionReading>(
  readings: readonly T[],
  olderNeighbour?: CompositionReading,
): WithChange<T>[] {
  const ordered = [...readings].sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));

  return ordered.map((reading, index) => {
    // The array is newest-first, so the older neighbour is the next index —
    // falling off the end onto the caller's extra row, if it supplied one.
    const older = ordered[index + 1] ?? olderNeighbour;

    return older ? { ...reading, changeCm: reading.valueCm - older.valueCm } : { ...reading };
  });
}

/**
 * Net change across a whole series, oldest to newest.
 *
 * Undefined for fewer than two readings: one measurement is a position, not a
 * direction, and reporting it as "no change" would be a claim the data does not
 * support.
 */
export function netChangeCm(readings: readonly CompositionReading[]): number | undefined {
  if (readings.length < 2) return undefined;

  const ordered = [...readings].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));

  return ordered[ordered.length - 1]!.valueCm - ordered[0]!.valueCm;
}

// ---------------------------------------------------------------------------
// Direction of change
// ---------------------------------------------------------------------------

/**
 * How closely a tape measure repeats on the same body, in centimetres.
 *
 * Self-measurement with a tape does not repeat exactly: the tape sits a
 * centimetre higher, it is pulled a little tighter, the athlete breathes. Half
 * a centimetre is a conservative floor for that, and it matters because a
 * difference smaller than it is not a change — it is the same measurement taken
 * twice. Presenting 0.2 cm as progress teaches an athlete to read noise as
 * signal, and then to act on it.
 *
 * Named and exported so the threshold is one inspectable number rather than a
 * literal buried in whichever screen happened to need it first.
 */
export const TAPE_REPEATABILITY_CM = 0.5;

export type ChangeDirection = 'up' | 'down' | 'steady';

/**
 * Classify a change, with anything inside the noise floor reported as steady.
 *
 * `steady` is a positive statement, not a missing answer: the measurement did
 * not move by more than the tape can resolve. It is distinct from having no
 * change to report at all, which is `undefined` and never reaches here.
 */
export function changeDirection(
  deltaCm: number,
  thresholdCm: number = TAPE_REPEATABILITY_CM,
): ChangeDirection {
  if (!Number.isFinite(deltaCm) || Math.abs(deltaCm) < thresholdCm) return 'steady';
  return deltaCm > 0 ? 'up' : 'down';
}

/**
 * True when a change is big enough to be worth reporting as one.
 *
 * Deliberately no notion of good or bad. A waist coming down and an arm coming
 * down are not the same news, and nothing in this package knows which the
 * athlete was training for.
 */
export function isMeaningfulChange(
  deltaCm: number,
  thresholdCm: number = TAPE_REPEATABILITY_CM,
): boolean {
  return changeDirection(deltaCm, thresholdCm) !== 'steady';
}

// ---------------------------------------------------------------------------
// Body fat from circumferences
// ---------------------------------------------------------------------------

/**
 * Which set of published coefficients to apply.
 *
 * The US Navy method is two equations fitted on two reference populations, not
 * one equation with a sex parameter. Naming the variants after those
 * populations is accurate; treating the choice as a statement about the athlete
 * would not be.
 */
export type NavyVariant = 'male' | 'female';

/**
 * Published coefficients for the metric form of the US Navy equation.
 *
 * Kept as data rather than inlined into the arithmetic so the numbers being
 * applied are visible, checkable against the source, and correctable in one
 * place if a different published variant is ever wanted.
 */
export const NAVY_COEFFICIENTS: Record<
  NavyVariant,
  { intercept: number; girth: number; height: number }
> = {
  male: { intercept: 1.0324, girth: 0.19077, height: 0.15456 },
  female: { intercept: 1.29579, girth: 0.35004, height: 0.221 },
};

/**
 * Standard error of the estimate, in percentage points.
 *
 * This is why the result is reported as a band. The method's published error is
 * around three to four points against hydrostatic weighing, so a single figure
 * from it is precision the equation does not have. Held as a named constant so
 * the width of every band traces back to one inspectable number rather than
 * being invented at the call site.
 */
export const NAVY_STANDARD_ERROR = 3.5;

/** Plausible output range. Anything outside it means the inputs are wrong. */
const PLAUSIBLE_PERCENT = { min: 2, max: 70 } as const;

export interface CalculationStep {
  /** What this step is, in the athlete's terms. */
  label: string;
  /** The arithmetic, with the numbers filled in. */
  expression: string;
  value: number;
  /** Unit of `value`, where it has one. */
  unit?: string;
}

export interface NavyInputs {
  variant: NavyVariant;
  waistCm: number;
  neckCm: number;
  heightCm: number;
  /** Required by the female variant, ignored by the male one. */
  hipsCm?: number;
}

export type CircumferenceMethod = 'navy' | 'ymca';

export type NavyEstimate =
  | {
      ok: true;
      variant: NavyVariant;
      /** Lower and upper bound, percent. */
      valueLow: number;
      valueHigh: number;
      standardError: number;
      /** Every intermediate value, in order, ending with the raw result. */
      steps: readonly CalculationStep[];
    }
  | {
      ok: false;
      variant: NavyVariant;
      /** Athlete-facing explanation of why it could not run. */
      reason: string;
      /** Steps completed before it failed, so the problem is locatable. */
      steps: readonly CalculationStep[];
    };

const round = (value: number, places: number): number => Number(value.toFixed(places));

/**
 * Estimate body fat from circumferences using the US Navy equation.
 *
 * Returns the band and every step that produced it. The steps are not a debug
 * aid — they are the feature. An estimate an athlete cannot inspect is a number
 * they have to take on trust, and this one does not deserve that much trust:
 * seeing that it reduces to a waist-minus-neck measurement and two logarithms
 * is what stops it being read as a body scan.
 *
 * All inputs are canonical centimetres. Callers convert at the edge, as they do
 * everywhere else in this package.
 *
 * Failure is a result, not an exception, and carries the steps completed so
 * far. "Waist minus neck came out negative" locates the problem for the athlete
 * in a way "could not calculate" never does.
 */
export function estimateBodyFatNavy(inputs: NavyInputs): NavyEstimate {
  const { variant, waistCm, neckCm, heightCm } = inputs;
  const coefficients = NAVY_COEFFICIENTS[variant];
  const steps: CalculationStep[] = [];

  const fail = (reason: string): NavyEstimate => ({ ok: false, variant, reason, steps });

  for (const [name, value] of [
    ['waist', waistCm],
    ['neck', neckCm],
    ['height', heightCm],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      return fail(`The ${name} measurement is missing or not a usable number.`);
    }
  }

  if (variant === 'female' && (!Number.isFinite(inputs.hipsCm) || (inputs.hipsCm ?? 0) <= 0)) {
    return fail('This equation also reads the hips, and that measurement is missing.');
  }

  // Girth term: waist minus neck, plus hips on the female variant.
  const girth = variant === 'female' ? waistCm + (inputs.hipsCm ?? 0) - neckCm : waistCm - neckCm;

  steps.push({
    label: variant === 'female' ? 'Waist plus hips, minus neck' : 'Waist minus neck',
    expression:
      variant === 'female'
        ? `${waistCm.toFixed(1)} + ${(inputs.hipsCm ?? 0).toFixed(1)} − ${neckCm.toFixed(1)}`
        : `${waistCm.toFixed(1)} − ${neckCm.toFixed(1)}`,
    value: round(girth, 1),
    unit: 'cm',
  });

  if (girth <= 0) {
    // log10 of a non-positive number is where this would turn into NaN, and a
    // NaN percentage rendered on a screen is worse than a plain refusal.
    return fail(
      'That combination gives a girth of zero or less, so the equation cannot run. Check the waist and neck measurements.',
    );
  }

  const logGirth = Math.log10(girth);
  steps.push({
    label: 'Log of that girth',
    expression: `log₁₀(${girth.toFixed(1)})`,
    value: round(logGirth, 4),
  });

  const logHeight = Math.log10(heightCm);
  steps.push({
    label: 'Log of height',
    expression: `log₁₀(${heightCm.toFixed(1)})`,
    value: round(logHeight, 4),
  });

  const denominator =
    coefficients.intercept - coefficients.girth * logGirth + coefficients.height * logHeight;
  steps.push({
    label: 'Denominator',
    expression: `${coefficients.intercept} − ${coefficients.girth} × ${logGirth.toFixed(4)} + ${coefficients.height} × ${logHeight.toFixed(4)}`,
    value: round(denominator, 4),
  });

  if (denominator <= 0) {
    return fail('The equation divides by a value that came out at zero or less for these inputs.');
  }

  const percent = 495 / denominator - 450;
  steps.push({
    label: 'Body fat from the equation',
    expression: `495 ÷ ${denominator.toFixed(4)} − 450`,
    value: round(percent, 1),
    unit: '%',
  });

  if (percent < PLAUSIBLE_PERCENT.min || percent > PLAUSIBLE_PERCENT.max) {
    return fail(
      'The equation produced a figure outside any plausible range, which means one of the measurements is wrong rather than unusual.',
    );
  }

  return {
    ok: true,
    variant,
    // The band, not the figure: the method's own error is what makes a single
    // number from it misleading.
    valueLow: round(Math.max(PLAUSIBLE_PERCENT.min, percent - NAVY_STANDARD_ERROR), 1),
    valueHigh: round(Math.min(PLAUSIBLE_PERCENT.max, percent + NAVY_STANDARD_ERROR), 1),
    standardError: NAVY_STANDARD_ERROR,
    steps,
  };
}

// ---------------------------------------------------------------------------
// YMCA
// ---------------------------------------------------------------------------

/**
 * Published coefficients for the YMCA equation.
 *
 * The equation is stated in inches and pounds, so the conversion happens inside
 * the function rather than by rewriting the constants into metric — rewritten
 * coefficients cannot be checked against the source, and a transcription error
 * in them would be invisible.
 */
export const YMCA_COEFFICIENTS: Record<NavyVariant, { intercept: number }> = {
  male: { intercept: -98.42 },
  female: { intercept: -76.76 },
};

const YMCA_WAIST_TERM = 4.15;
const YMCA_WEIGHT_TERM = 0.082;

/**
 * Standard error of the YMCA estimate, in percentage points.
 *
 * Wider than the Navy equation's. It reads two measurements rather than three
 * and carries no height term at all, so it has less to go on and its band
 * should say so.
 */
export const YMCA_STANDARD_ERROR = 4;

export interface YmcaInputs {
  variant: NavyVariant;
  waistCm: number;
  weightKg: number;
}

/**
 * Estimate body fat from waist and weight using the YMCA equation.
 *
 * Offered alongside the Navy method because it reads a different pair of
 * measurements: an athlete who has their weight but has not measured their neck
 * can still get an estimate, and one who has neck and height but no scale can
 * use the other. Neither is a fallback for the other — they are two equations
 * with two input sets, and which one an athlete can run depends on what they
 * measured.
 *
 * Same contract as the Navy function: all inputs canonical (centimetres,
 * kilograms), every step reported, and failure returned rather than thrown.
 */
export function estimateBodyFatYmca(inputs: YmcaInputs): NavyEstimate {
  const { variant, waistCm, weightKg } = inputs;
  const steps: CalculationStep[] = [];
  const fail = (reason: string): NavyEstimate => ({ ok: false, variant, reason, steps });

  for (const [name, value] of [
    ['waist', waistCm],
    ['weight', weightKg],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      return fail(`The ${name} measurement is missing or not a usable number.`);
    }
  }

  // The published equation is in inches and pounds; convert here rather than
  // rewriting the constants, so they stay checkable against the source.
  const waistInches = waistCm / 2.54;
  steps.push({
    label: 'Waist in inches',
    expression: `${waistCm.toFixed(1)} ÷ 2.54`,
    value: round(waistInches, 2),
    unit: 'in',
  });

  const weightPounds = weightKg / 0.45359237;
  steps.push({
    label: 'Weight in pounds',
    expression: `${weightKg.toFixed(1)} ÷ 0.45359237`,
    value: round(weightPounds, 1),
    unit: 'lb',
  });

  const intercept = YMCA_COEFFICIENTS[variant].intercept;
  const numerator = intercept + YMCA_WAIST_TERM * waistInches - YMCA_WEIGHT_TERM * weightPounds;
  steps.push({
    label: 'Numerator',
    expression: `${intercept} + ${YMCA_WAIST_TERM} × ${waistInches.toFixed(2)} − ${YMCA_WEIGHT_TERM} × ${weightPounds.toFixed(1)}`,
    value: round(numerator, 3),
  });

  const percent = (numerator / weightPounds) * 100;
  steps.push({
    label: 'Body fat from the equation',
    expression: `${numerator.toFixed(3)} ÷ ${weightPounds.toFixed(1)} × 100`,
    value: round(percent, 1),
    unit: '%',
  });

  if (percent < PLAUSIBLE_PERCENT.min || percent > PLAUSIBLE_PERCENT.max) {
    return fail(
      'The equation produced a figure outside any plausible range, which means one of the measurements is wrong rather than unusual.',
    );
  }

  return {
    ok: true,
    variant,
    valueLow: round(Math.max(PLAUSIBLE_PERCENT.min, percent - YMCA_STANDARD_ERROR), 1),
    valueHigh: round(Math.min(PLAUSIBLE_PERCENT.max, percent + YMCA_STANDARD_ERROR), 1),
    standardError: YMCA_STANDARD_ERROR,
    steps,
  };
}

export interface CircumferenceInputs {
  variant: NavyVariant;
  waistCm: number;
  neckCm?: number;
  heightCm?: number;
  hipsCm?: number;
  weightKg?: number;
}

/**
 * Which circumference methods the measurements on hand can actually run.
 *
 * Returned in the order they should be preferred: the Navy equation reads three
 * sites and a height and is the tighter of the two, so it leads when both are
 * available. Neither is a fallback for the other in the sense of being worse —
 * YMCA simply reads less, and its band says so.
 */
export function availableCircumferenceMethods(inputs: CircumferenceInputs): CircumferenceMethod[] {
  const positive = (value: number | undefined): boolean =>
    value !== undefined && Number.isFinite(value) && value > 0;

  const methods: CircumferenceMethod[] = [];

  const navyReady =
    positive(inputs.waistCm) &&
    positive(inputs.neckCm) &&
    positive(inputs.heightCm) &&
    (inputs.variant === 'male' || positive(inputs.hipsCm));
  if (navyReady) methods.push('navy');

  if (positive(inputs.waistCm) && positive(inputs.weightKg)) methods.push('ymca');

  return methods;
}

/**
 * Run one named circumference method.
 *
 * A single entry point so callers pick a method by name and get the same result
 * shape either way, rather than branching on which function to call and then
 * branching again on two slightly different return types.
 */
export function estimateBodyFat(
  method: CircumferenceMethod,
  inputs: CircumferenceInputs,
): NavyEstimate {
  if (method === 'ymca') {
    return estimateBodyFatYmca({
      variant: inputs.variant,
      waistCm: inputs.waistCm,
      weightKg: inputs.weightKg ?? Number.NaN,
    });
  }

  return estimateBodyFatNavy({
    variant: inputs.variant,
    waistCm: inputs.waistCm,
    neckCm: inputs.neckCm ?? Number.NaN,
    heightCm: inputs.heightCm ?? Number.NaN,
    ...(inputs.hipsCm !== undefined ? { hipsCm: inputs.hipsCm } : {}),
  });
}
