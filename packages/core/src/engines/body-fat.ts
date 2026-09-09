/**
 * Body-fat estimation from tape measurements.
 *
 * Two published circumference formulas, computed deterministically from the
 * canonical centimetre values a session stores, with every input and step
 * exposed so the athlete can see exactly where a number came from.
 *
 * US Navy (Hodgdon and Beckett, 1984)
 * -----------------------------------
 * Uses neck, waist and height for men; neck, waist, hips and height for
 * women. Validated against hydrostatic weighing with a standard error of
 * about 3.5 percentage points. It is the better of the two and is preferred
 * whenever its inputs exist.
 *
 * YMCA
 * ----
 * Uses waist and body weight only. Quick, but it cannot tell a heavy waist
 * from a heavy frame, so its error is wider and it is treated as a rough
 * guide. Its real value is as a cross-check: when it agrees with the Navy
 * formula the tape was probably placed well.
 *
 * What comes out
 * --------------
 * Never a single number. Every estimate is a range whose width comes from the
 * formula's published error, widened when the inputs are weaker, with a
 * confidence label (`low`, `moderate`, `high`) and the plain-language reasons
 * behind it. The note attached to every estimate says it is not a medical
 * measurement, and the UI is expected to show it.
 *
 * Photo-based estimates from an external vision service pass through the same
 * labelling (`labelAiBodyFat`) so both paths present identically. A photo
 * estimate is never labelled `high`: nothing here validates it against a
 * reference method.
 */

import type { BiologicalSex } from '../domain/athlete.js';
import type { CircumferencePointCode } from '../domain/body-composition.js';
import { circumferencePoint, cmToInches } from '../domain/body-composition.js';
import type { ConfidenceLevel } from '../domain/provenance.js';
import { clamp, compact, round } from '../util/stats.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const BODY_FAT_FORMULAS = ['us_navy', 'ymca'] as const;
export type BodyFatFormula = (typeof BODY_FAT_FORMULAS)[number];

/** How an estimate was produced: a tape formula or the photo service. */
export type BodyFatMethod = 'formula' | 'ai';

export type AiServiceStatus = 'active' | 'unavailable' | 'failed';

/** Which sex-specific variant of a formula produced the estimate. */
export type FormulaVariant = 'male' | 'female' | 'both';

/** Attached to every estimate. Shown to the athlete, not just logged. */
export const BODY_FAT_ESTIMATE_NOTE =
  'An estimate for tracking your own trend, not a medical measurement or a diagnosis.';

const KG_PER_POUND = 0.45359237;
const kgToPounds = (kg: number): number => kg / KG_PER_POUND;

export interface BodyFatInputs {
  sex: BiologicalSex;
  heightCm?: number;
  weightKg?: number;
  /** Canonical centimetre values, keyed by tape point. */
  circumferencesCm: Partial<Record<CircumferencePointCode, number>>;
}

/** One value the formula consumed, in the unit it was consumed in. */
export interface EstimateInput {
  key: string;
  label: string;
  value: number;
  unit: string;
}

/** One line of working, with the numbers substituted in. */
export interface CalculationStep {
  label: string;
  detail: string;
  result: number;
}

export interface BodyFatEstimate {
  method: BodyFatMethod;
  formula?: BodyFatFormula;
  variant?: FormulaVariant;
  /** Percent body fat the range is centred on. */
  value: number;
  /** Lower bound of the range, percent. */
  valueLow: number;
  /** Upper bound of the range, percent. */
  valueHigh: number;
  confidence: ConfidenceLevel;
  /** Why the confidence is what it is, in plain words, for the UI to show. */
  confidenceReasons: string[];
  inputs: EstimateInput[];
  steps: CalculationStep[];
  note: string;
}

/** A formula that could not run, and the inputs it still needs. */
export interface FormulaRequirement {
  formula: BodyFatFormula;
  /** Human labels of the missing inputs, e.g. "Neck", "Height". */
  missing: string[];
}

export interface BodyFatAssessment {
  /** Every formula that could run, best first. */
  estimates: BodyFatEstimate[];
  /** The estimate to lead with, when there is one. */
  primary?: BodyFatEstimate;
  unavailable: FormulaRequirement[];
  note: string;
}

// ---------------------------------------------------------------------------
// Ranges and plausibility
// ---------------------------------------------------------------------------

/**
 * Half-width of the reported range, in percentage points. Starts from each
 * formula's published error and widens as confidence drops. The YMCA formula
 * never reaches `high`; the entry exists so the table is total.
 */
const RANGE_HALF_WIDTH: Record<BodyFatFormula, Record<ConfidenceLevel, number>> = {
  us_navy: { high: 3, moderate: 3.5, low: 5 },
  ymca: { high: 4, moderate: 4.5, low: 6 },
};

/** Narrowest range a photo estimate may claim, by confidence. */
const AI_MIN_HALF_WIDTH: Record<ConfidenceLevel, number> = { high: 4, moderate: 4, low: 6 };

/** Formulas agreeing this closely corroborate each other. */
const AGREEMENT_POINTS = 3;
/** Formulas this far apart point to a tape placement problem. */
const DISAGREEMENT_POINTS = 6;

const PLAUSIBLE_PERCENT: readonly [number, number] = [2, 60];
const REPORTABLE_PERCENT: readonly [number, number] = [0, 70];

/** Input ranges the formulas were validated on. Outside them the fit is unknown. */
const PLAUSIBLE_INPUT_CM: Record<'height' | 'neck' | 'waist' | 'hips', [number, number]> = {
  height: [120, 230],
  neck: [20, 60],
  waist: [40, 200],
  hips: [60, 200],
};
const PLAUSIBLE_WEIGHT_KG: readonly [number, number] = [25, 300];

const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = { high: 3, moderate: 2, low: 1 };

function inRange(value: number, range: readonly [number, number]): boolean {
  return value >= range[0] && value <= range[1];
}

const fmt = (value: number, decimals = 1): string => value.toFixed(decimals);

// ---------------------------------------------------------------------------
// Drafts: a formula's raw output before the range is decided
// ---------------------------------------------------------------------------

interface Draft {
  formula: BodyFatFormula;
  variant: FormulaVariant;
  /** Point values per variant; one entry unless sex is unspecified. */
  values: number[];
  confidence: ConfidenceLevel;
  reasons: string[];
  inputs: EstimateInput[];
  steps: CalculationStep[];
}

function lower(level: ConfidenceLevel): ConfidenceLevel {
  return level === 'high' ? 'moderate' : 'low';
}

function raise(level: ConfidenceLevel): ConfidenceLevel {
  return level === 'low' ? 'moderate' : 'high';
}

function midpoint(values: readonly number[]): number {
  return (Math.min(...values) + Math.max(...values)) / 2;
}

/** Apply the checks common to both formulas: variant, plausibility of the result. */
function applyCommonChecks(draft: Draft, sex: BiologicalSex): Draft {
  let { confidence } = draft;
  const reasons = [...draft.reasons];

  if (sex === 'unspecified') {
    confidence = 'low';
    reasons.push(
      draft.variant === 'both'
        ? 'Sex is not set on your profile, so both formula variants are shown as one wider range.'
        : 'Sex is not set on your profile, so the male variant of the formula was used.',
    );
  }

  const value = midpoint(draft.values);
  if (!inRange(value, PLAUSIBLE_PERCENT)) {
    confidence = 'low';
    reasons.push('The result falls outside the plausible range; check the tape placement.');
  }

  return { ...draft, confidence, reasons };
}

function finalize(draft: Draft): BodyFatEstimate {
  const halfWidth = RANGE_HALF_WIDTH[draft.formula][draft.confidence];
  const low = Math.min(...draft.values) - halfWidth;
  const high = Math.max(...draft.values) + halfWidth;
  return {
    method: 'formula',
    formula: draft.formula,
    variant: draft.variant,
    value: round(midpoint(draft.values), 1),
    valueLow: round(clamp(low, REPORTABLE_PERCENT[0], REPORTABLE_PERCENT[1]), 1),
    valueHigh: round(clamp(high, REPORTABLE_PERCENT[0], REPORTABLE_PERCENT[1]), 1),
    confidence: draft.confidence,
    confidenceReasons: draft.reasons,
    inputs: draft.inputs,
    steps: draft.steps,
    note: BODY_FAT_ESTIMATE_NOTE,
  };
}

// ---------------------------------------------------------------------------
// US Navy
// ---------------------------------------------------------------------------

interface NavyMeasures {
  heightCm: number;
  neckCm: number;
  waistCm: number;
  hipsCm?: number;
}

function navyMale(m: NavyMeasures): { percent: number; steps: CalculationStep[] } {
  const girth = m.waistCm - m.neckCm;
  const logGirth = Math.log10(girth);
  const logHeight = Math.log10(m.heightCm);
  const denominator = 1.0324 - 0.19077 * logGirth + 0.15456 * logHeight;
  const percent = 495 / denominator - 450;
  return {
    percent,
    steps: [
      {
        label: 'Waist minus neck',
        detail: `${fmt(m.waistCm)} cm − ${fmt(m.neckCm)} cm`,
        result: round(girth, 1),
      },
      {
        label: 'Log of waist minus neck',
        detail: `log10(${fmt(girth)})`,
        result: round(logGirth, 4),
      },
      { label: 'Log of height', detail: `log10(${fmt(m.heightCm)})`, result: round(logHeight, 4) },
      {
        label: 'Formula denominator (male)',
        detail: `1.0324 − 0.19077 × ${fmt(logGirth, 4)} + 0.15456 × ${fmt(logHeight, 4)}`,
        result: round(denominator, 4),
      },
      {
        label: 'Body fat (male)',
        detail: `495 ÷ ${fmt(denominator, 4)} − 450`,
        result: round(percent, 1),
      },
    ],
  };
}

function navyFemale(m: NavyMeasures & { hipsCm: number }): {
  percent: number;
  steps: CalculationStep[];
} {
  const girth = m.waistCm + m.hipsCm - m.neckCm;
  const logGirth = Math.log10(girth);
  const logHeight = Math.log10(m.heightCm);
  const denominator = 1.29579 - 0.35004 * logGirth + 0.221 * logHeight;
  const percent = 495 / denominator - 450;
  return {
    percent,
    steps: [
      {
        label: 'Waist plus hips minus neck',
        detail: `${fmt(m.waistCm)} cm + ${fmt(m.hipsCm)} cm − ${fmt(m.neckCm)} cm`,
        result: round(girth, 1),
      },
      {
        label: 'Log of waist plus hips minus neck',
        detail: `log10(${fmt(girth)})`,
        result: round(logGirth, 4),
      },
      { label: 'Log of height', detail: `log10(${fmt(m.heightCm)})`, result: round(logHeight, 4) },
      {
        label: 'Formula denominator (female)',
        detail: `1.29579 − 0.35004 × ${fmt(logGirth, 4)} + 0.22100 × ${fmt(logHeight, 4)}`,
        result: round(denominator, 4),
      },
      {
        label: 'Body fat (female)',
        detail: `495 ÷ ${fmt(denominator, 4)} − 450`,
        result: round(percent, 1),
      },
    ],
  };
}

/** Inputs the Navy formula still needs, as human labels. Empty when it can run. */
export function usNavyRequirements(inputs: BodyFatInputs): string[] {
  const missing: string[] = [];
  if (inputs.heightCm === undefined) missing.push('Height');
  if (inputs.circumferencesCm.neck === undefined) missing.push(circumferencePoint('neck').label);
  if (inputs.circumferencesCm.waist === undefined) missing.push(circumferencePoint('waist').label);
  if (inputs.sex === 'female' && inputs.circumferencesCm.hips === undefined) {
    missing.push(circumferencePoint('hips').label);
  }
  const { neck, waist } = inputs.circumferencesCm;
  if (neck !== undefined && waist !== undefined && waist - neck <= 0) {
    // The logarithm has no answer here; the tape was almost certainly misread.
    missing.push('A waist measurement larger than the neck');
  }
  return missing;
}

function navyDraft(inputs: BodyFatInputs): Draft | undefined {
  if (usNavyRequirements(inputs).length > 0) return undefined;
  const heightCm = inputs.heightCm!;
  const neckCm = inputs.circumferencesCm.neck!;
  const waistCm = inputs.circumferencesCm.waist!;
  const hipsCm = inputs.circumferencesCm.hips;

  const reasons = ['US Navy tape formula: typical error about 3.5 points either way.'];
  let confidence: ConfidenceLevel = 'moderate';

  const measured: EstimateInput[] = [
    { key: 'height', label: 'Height', value: round(heightCm, 1), unit: 'cm' },
    { key: 'neck', label: circumferencePoint('neck').label, value: round(neckCm, 1), unit: 'cm' },
    {
      key: 'waist',
      label: circumferencePoint('waist').label,
      value: round(waistCm, 1),
      unit: 'cm',
    },
  ];

  const useFemale =
    inputs.sex === 'female' || (inputs.sex === 'unspecified' && hipsCm !== undefined);
  const useMale = inputs.sex !== 'female';
  if (useFemale) {
    measured.push({
      key: 'hips',
      label: circumferencePoint('hips').label,
      value: round(hipsCm!, 1),
      unit: 'cm',
    });
  }

  const checks: Array<[string, number, [number, number]]> = [
    ['Height', heightCm, PLAUSIBLE_INPUT_CM.height],
    ['Neck', neckCm, PLAUSIBLE_INPUT_CM.neck],
    ['Waist', waistCm, PLAUSIBLE_INPUT_CM.waist],
  ];
  if (useFemale) checks.push(['Hips', hipsCm!, PLAUSIBLE_INPUT_CM.hips]);
  for (const [label, value, range] of checks) {
    if (!inRange(value, range)) {
      confidence = 'low';
      reasons.push(`${label} is outside the range the formula was validated for.`);
    }
  }
  const values: number[] = [];
  const steps: CalculationStep[] = [];
  if (useMale) {
    const male = navyMale({ heightCm, neckCm, waistCm });
    values.push(male.percent);
    steps.push(...male.steps);
  }
  if (useFemale) {
    const female = navyFemale({ heightCm, neckCm, waistCm, hipsCm: hipsCm! });
    values.push(female.percent);
    steps.push(...female.steps);
  }

  const variant: FormulaVariant = useMale && useFemale ? 'both' : useMale ? 'male' : 'female';
  return applyCommonChecks(
    { formula: 'us_navy', variant, values, confidence, reasons, inputs: measured, steps },
    inputs.sex,
  );
}

/** US Navy estimate on its own, without the YMCA cross-check. */
export function usNavyBodyFat(inputs: BodyFatInputs): BodyFatEstimate | undefined {
  const draft = navyDraft(inputs);
  return draft ? finalize(draft) : undefined;
}

// ---------------------------------------------------------------------------
// YMCA
// ---------------------------------------------------------------------------

/** Inputs the YMCA formula still needs, as human labels. Empty when it can run. */
export function ymcaRequirements(inputs: BodyFatInputs): string[] {
  const missing: string[] = [];
  if (inputs.circumferencesCm.waist === undefined) missing.push(circumferencePoint('waist').label);
  if (inputs.weightKg === undefined) missing.push('Weight');
  return missing;
}

function ymcaVariant(
  variant: 'male' | 'female',
  waistIn: number,
  weightLb: number,
): { percent: number; steps: CalculationStep[] } {
  const constant = variant === 'male' ? -98.42 : -76.76;
  const fatMassLb = constant + 4.15 * waistIn - 0.082 * weightLb;
  const percent = (fatMassLb / weightLb) * 100;
  return {
    percent,
    steps: [
      {
        label: `Fat mass (${variant})`,
        detail: `${fmt(constant, 2)} + 4.15 × ${fmt(waistIn, 2)} − 0.082 × ${fmt(weightLb)}`,
        result: round(fatMassLb, 1),
      },
      {
        label: `Body fat (${variant})`,
        detail: `${fmt(fatMassLb)} ÷ ${fmt(weightLb)} × 100`,
        result: round(percent, 1),
      },
    ],
  };
}

function ymcaDraft(inputs: BodyFatInputs): Draft | undefined {
  if (ymcaRequirements(inputs).length > 0) return undefined;
  const waistCm = inputs.circumferencesCm.waist!;
  const weightKg = inputs.weightKg!;

  const reasons = ['YMCA formula uses only waist and weight, so it is a rough guide.'];
  const confidence: ConfidenceLevel = 'low';

  if (!inRange(waistCm, PLAUSIBLE_INPUT_CM.waist)) {
    reasons.push('Waist is outside the range the formula was validated for.');
  }
  if (!inRange(weightKg, PLAUSIBLE_WEIGHT_KG)) {
    reasons.push('Weight is outside the range the formula was validated for.');
  }

  // The formula is published in inches and pounds; the conversion is shown so
  // the athlete can follow the working from their own centimetre values.
  const waistIn = cmToInches(waistCm);
  const weightLb = kgToPounds(weightKg);
  const steps: CalculationStep[] = [
    { label: 'Waist in inches', detail: `${fmt(waistCm)} cm ÷ 2.54`, result: round(waistIn, 2) },
    {
      label: 'Weight in pounds',
      detail: `${fmt(weightKg)} kg ÷ 0.4536`,
      result: round(weightLb, 1),
    },
  ];

  const measured: EstimateInput[] = [
    {
      key: 'waist',
      label: circumferencePoint('waist').label,
      value: round(waistCm, 1),
      unit: 'cm',
    },
    { key: 'weight', label: 'Weight', value: round(weightKg, 1), unit: 'kg' },
  ];

  const values: number[] = [];
  const useMale = inputs.sex !== 'female';
  const useFemale = inputs.sex !== 'male';
  if (useMale) {
    const male = ymcaVariant('male', waistIn, weightLb);
    values.push(male.percent);
    steps.push(...male.steps);
  }
  if (useFemale) {
    const female = ymcaVariant('female', waistIn, weightLb);
    values.push(female.percent);
    steps.push(...female.steps);
  }

  const variant: FormulaVariant = useMale && useFemale ? 'both' : useMale ? 'male' : 'female';
  return applyCommonChecks(
    { formula: 'ymca', variant, values, confidence, reasons, inputs: measured, steps },
    inputs.sex,
  );
}

/** YMCA estimate on its own, without the Navy cross-check. */
export function ymcaBodyFat(inputs: BodyFatInputs): BodyFatEstimate | undefined {
  const draft = ymcaDraft(inputs);
  return draft ? finalize(draft) : undefined;
}

// ---------------------------------------------------------------------------
// Assessment: run every formula, cross-check, rank
// ---------------------------------------------------------------------------

/** Whether a draft carries any warning beyond its formula's baseline line. */
function isClean(draft: Draft, sex: BiologicalSex): boolean {
  return sex !== 'unspecified' && draft.reasons.length === 1;
}

/**
 * Two independent formulas agreeing is real evidence the tape was placed
 * well; disagreeing badly is real evidence it was not. Only clean drafts are
 * upgraded: agreement cannot rescue an implausible input.
 */
function crossCheck(navy: Draft, ymca: Draft, sex: BiologicalSex): [Draft, Draft] {
  const gap = Math.abs(midpoint(navy.values) - midpoint(ymca.values));
  const gapText = fmt(gap);

  if (gap <= AGREEMENT_POINTS && isClean(navy, sex) && isClean(ymca, sex)) {
    return [
      {
        ...navy,
        confidence: raise(navy.confidence),
        reasons: [...navy.reasons, `The YMCA formula agrees within ${gapText} points.`],
      },
      {
        ...ymca,
        confidence: raise(ymca.confidence),
        reasons: [...ymca.reasons, `The US Navy formula agrees within ${gapText} points.`],
      },
    ];
  }

  if (gap > DISAGREEMENT_POINTS) {
    const reason = `The two formulas disagree by ${gapText} points; re-check the tape placement.`;
    return [
      { ...navy, confidence: lower(navy.confidence), reasons: [...navy.reasons, reason] },
      { ...ymca, confidence: 'low', reasons: [...ymca.reasons, reason] },
    ];
  }

  const reason = `The two formulas differ by ${gapText} points.`;
  return [
    { ...navy, reasons: [...navy.reasons, reason] },
    { ...ymca, reasons: [...ymca.reasons, reason] },
  ];
}

const METHOD_RANK: Record<string, number> = { us_navy: 3, ymca: 2, ai: 1 };

function estimateRank(estimate: BodyFatEstimate): number {
  return METHOD_RANK[estimate.formula ?? estimate.method] ?? 0;
}

/**
 * The estimate to lead with: highest confidence first, then the better
 * method. Deterministic for a given input order.
 */
export function preferredBodyFatEstimate(
  estimates: readonly BodyFatEstimate[],
): BodyFatEstimate | undefined {
  return [...estimates].sort(
    (a, b) =>
      CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
      estimateRank(b) - estimateRank(a),
  )[0];
}

/**
 * Run every formula the inputs allow, cross-check them against each other,
 * and say what the others still need.
 */
export function estimateBodyFat(inputs: BodyFatInputs): BodyFatAssessment {
  let navy = navyDraft(inputs);
  let ymca = ymcaDraft(inputs);
  if (navy && ymca) [navy, ymca] = crossCheck(navy, ymca, inputs.sex);

  const estimates = compact([navy, ymca].map((draft) => (draft ? finalize(draft) : undefined)));
  const ordered = [...estimates].sort(
    (a, b) =>
      CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
      estimateRank(b) - estimateRank(a),
  );

  const unavailable: FormulaRequirement[] = [];
  const navyMissing = usNavyRequirements(inputs);
  if (navyMissing.length > 0) unavailable.push({ formula: 'us_navy', missing: navyMissing });
  const ymcaMissing = ymcaRequirements(inputs);
  if (ymcaMissing.length > 0) unavailable.push({ formula: 'ymca', missing: ymcaMissing });

  return { estimates: ordered, primary: ordered[0], unavailable, note: BODY_FAT_ESTIMATE_NOTE };
}

// ---------------------------------------------------------------------------
// Photo (AI) estimates
// ---------------------------------------------------------------------------

/** What the vision service reported, already parsed by the API layer. */
export interface AiBodyFatReading {
  /** Percent body fat the service reported. */
  value: number;
  valueLow?: number;
  valueHigh?: number;
  /** Service-reported confidence, 0 to 1, when it gives one. */
  modelConfidence?: number;
  /** How many of the four sides the service actually analysed. */
  photosAnalysed: number;
}

const AI_MODEL_CONFIDENCE_FLOOR = 0.7;
const AI_MAX_RANGE_WIDTH = 8;

/**
 * Put a photo estimate in the same clothes as a formula estimate. The
 * baseline is `low`: a photo model's number has no published error and
 * nothing here checks it against a reference. It reaches `moderate` when all
 * four sides were analysed, the service is confident, and the range it
 * reports is not implausibly tight. It never reaches `high`.
 */
export function labelAiBodyFat(reading: AiBodyFatReading): BodyFatEstimate {
  const reasons = ['Photo estimates are not validated against a reference method.'];
  let confidence: ConfidenceLevel = 'low';

  const allSides = reading.photosAnalysed >= 4;
  const confident =
    reading.modelConfidence !== undefined && reading.modelConfidence >= AI_MODEL_CONFIDENCE_FLOOR;
  const hasRange =
    reading.valueLow !== undefined &&
    reading.valueHigh !== undefined &&
    reading.valueLow <= reading.value &&
    reading.valueHigh >= reading.value;
  const tightEnough = !hasRange || reading.valueHigh! - reading.valueLow! <= AI_MAX_RANGE_WIDTH;

  reasons.push(
    allSides
      ? 'All four sides were analysed.'
      : `Only ${reading.photosAnalysed} of 4 sides were analysed.`,
  );
  if (reading.modelConfidence === undefined) {
    reasons.push('The service did not report how confident it was.');
  } else {
    reasons.push(
      confident
        ? 'The service reported good confidence in the photos.'
        : 'The service reported low confidence in the photos.',
    );
  }
  if (!tightEnough) reasons.push('The service reported a very wide range.');

  const plausible = inRange(reading.value, PLAUSIBLE_PERCENT);
  if (!plausible) reasons.push('The result falls outside the plausible range.');

  if (allSides && confident && tightEnough && plausible) confidence = 'moderate';

  const minHalf = AI_MIN_HALF_WIDTH[confidence];
  const value = clamp(reading.value, REPORTABLE_PERCENT[0], REPORTABLE_PERCENT[1]);
  const low = hasRange ? Math.min(reading.valueLow!, value - minHalf) : value - minHalf;
  const high = hasRange ? Math.max(reading.valueHigh!, value + minHalf) : value + minHalf;

  return {
    method: 'ai',
    value: round(value, 1),
    valueLow: round(clamp(low, REPORTABLE_PERCENT[0], REPORTABLE_PERCENT[1]), 1),
    valueHigh: round(clamp(high, REPORTABLE_PERCENT[0], REPORTABLE_PERCENT[1]), 1),
    confidence,
    confidenceReasons: reasons,
    inputs: [
      { key: 'photos', label: 'Photos analysed', value: reading.photosAnalysed, unit: 'photos' },
    ],
    steps: [
      {
        label: 'Service estimate',
        detail: 'as reported by the photo service',
        result: round(reading.value, 1),
      },
    ],
    note: BODY_FAT_ESTIMATE_NOTE,
  };
}

export interface AiServiceGuidance {
  status: AiServiceStatus;
  available: boolean;
  /** When true the UI should point the athlete at the tape formula. */
  useFormulaInstead: boolean;
  message: string;
}

/** What to tell the athlete about the photo service, by its status. */
export function aiServiceGuidance(status: AiServiceStatus): AiServiceGuidance {
  switch (status) {
    case 'active':
      return {
        status,
        available: true,
        useFormulaInstead: false,
        message: 'Photo analysis is available.',
      };
    case 'unavailable':
      return {
        status,
        available: false,
        useFormulaInstead: true,
        message: 'Photo analysis is not available right now. Use the tape formula instead.',
      };
    case 'failed':
      return {
        status,
        available: false,
        useFormulaInstead: true,
        message:
          'Photo analysis failed for this session. Use the tape formula, or try again later.',
      };
  }
}
