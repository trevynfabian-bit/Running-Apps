/**
 * The inputs a circumference formula needs beyond the tape.
 *
 * The US Navy equation takes waist, neck and height — and hips as well for one
 * of its two coefficient sets. The circumferences come from the session; this
 * module covers the rest: which coefficient set, height, and weight.
 *
 * On the coefficient set: the published formula was fitted on two reference
 * populations and provides two equations. This app asks which equation to use
 * and says so plainly, rather than asking the athlete to declare something
 * about themselves and quietly deciding on their behalf. The distinction
 * matters both because it is accurate — the formula genuinely is a choice of
 * coefficients — and because an athlete whose body does not sort neatly into
 * the reference populations is better served picking the equation that fits
 * their measurements than being told which one they are.
 *
 * Nothing here computes a body fat figure; that arrives with the formula
 * itself. This is the data-gathering half, and its job is to be clear about
 * what is still missing and why it is being asked for.
 */

/** Which of the published equation's two coefficient sets to apply. */
export type FormulaVariant = 'male' | 'female';

export const FORMULA_VARIANTS: readonly FormulaVariant[] = ['male', 'female'];

export const VARIANT_LABELS: Record<FormulaVariant, string> = {
  male: 'Male coefficients',
  female: 'Female coefficients',
};

/**
 * What each equation actually does, in the athlete's terms.
 *
 * Stated as what the equation reads, not as what the athlete is, so the choice
 * can be made on the measurements available.
 */
export const VARIANT_DESCRIPTIONS: Record<FormulaVariant, string> = {
  male: 'Reads waist, neck and height.',
  female: 'Reads waist, hips, neck and height.',
};

export const VARIANT_NOTE =
  'The published formula provides two sets of coefficients, fitted on different reference populations. Pick the one whose inputs match the measurements you take.';

/** Measure point codes each variant needs from the session. */
export const VARIANT_REQUIRED_POINTS: Record<FormulaVariant, readonly string[]> = {
  male: ['waist', 'neck'],
  female: ['waist', 'neck', 'hips'],
};

export interface SupportingInputs {
  variant?: FormulaVariant;
  /**
   * Canonical centimetres. Entered in whatever unit the athlete measures in —
   * someone who takes their waist in inches takes their height in inches too,
   * so height shares the tape preference rather than carrying its own.
   */
  heightCm?: number;
  /** Canonical kilograms. Not used by the Navy equation, but shown alongside. */
  weightKg?: number;
}

/** Where a prefilled value came from, so the screen can say. */
export type InputSource = 'profile' | 'session' | 'entered';

export const SOURCE_LABELS: Record<InputSource, string> = {
  profile: 'From your profile',
  session: 'From this session',
  entered: 'Entered now',
};

export interface Requirement {
  key: string;
  label: string;
  satisfied: boolean;
  /** Why it is needed, or what is missing. Shown either way. */
  detail: string;
}

/**
 * Plausible bounds, as a typo guard rather than a judgement.
 *
 * Wide enough to cover any adult and then some. They exist to catch a height
 * typed in metres (1.8 instead of 180) and a weight typed in the wrong unit,
 * and nothing else.
 */
export const HEIGHT_BOUNDS_CM = { min: 100, max: 250 } as const;
export const WEIGHT_BOUNDS_KG = { min: 25, max: 300 } as const;

export function isPlausibleHeightCm(value: number): boolean {
  return Number.isFinite(value) && value >= HEIGHT_BOUNDS_CM.min && value <= HEIGHT_BOUNDS_CM.max;
}

export function isPlausibleWeightKg(value: number): boolean {
  return Number.isFinite(value) && value >= WEIGHT_BOUNDS_KG.min && value <= WEIGHT_BOUNDS_KG.max;
}

/**
 * What the formula still needs, and what it already has.
 *
 * Returns every requirement, satisfied or not, rather than only the gaps. A
 * list that shrinks as it is filled tells the athlete nothing about what the
 * calculation rests on; a checklist that stays put and ticks over does.
 */
export function formulaRequirements(
  inputs: SupportingInputs,
  measuredPointCodes: readonly string[],
): Requirement[] {
  const requirements: Requirement[] = [
    {
      key: 'variant',
      label: 'Coefficient set',
      satisfied: inputs.variant !== undefined,
      detail: inputs.variant
        ? VARIANT_DESCRIPTIONS[inputs.variant]
        : 'Choose which of the two published equations to apply.',
    },
    {
      key: 'height',
      label: 'Height',
      satisfied: inputs.heightCm !== undefined && isPlausibleHeightCm(inputs.heightCm),
      detail:
        inputs.heightCm !== undefined && isPlausibleHeightCm(inputs.heightCm)
          ? 'Used directly by the equation.'
          : 'The equation divides by height, so it cannot run without one.',
    },
  ];

  // Circumferences are only listed once a variant is chosen: before that, which
  // ones are needed is genuinely unknown, and guessing would show the athlete a
  // requirement that might vanish.
  if (inputs.variant) {
    for (const code of VARIANT_REQUIRED_POINTS[inputs.variant]) {
      const measured = measuredPointCodes.includes(code);
      requirements.push({
        key: `point:${code}`,
        label: code === 'hips' ? 'Hips' : code === 'neck' ? 'Neck' : 'Waist',
        satisfied: measured,
        detail: measured
          ? 'Recorded in this session.'
          : 'Measure it on the circumference screen to complete the set.',
      });
    }
  }

  return requirements;
}

/** True when every requirement is met and the formula can run. */
export function canRunFormula(requirements: readonly Requirement[]): boolean {
  return requirements.length > 0 && requirements.every((requirement) => requirement.satisfied);
}

/** Requirements still outstanding, for a one-line summary. */
export function outstanding(requirements: readonly Requirement[]): Requirement[] {
  return requirements.filter((requirement) => !requirement.satisfied);
}
