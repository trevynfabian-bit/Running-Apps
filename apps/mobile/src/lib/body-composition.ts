/**
 * Body composition data layer.
 *
 * Built frontend-first: the screens are developed against the stub below so
 * they can be exercised before the API and database exist. The shapes mirror
 * the planned tables — body_composition_sessions, composition_photos,
 * circumference_points, body_measurements, body_fat_estimates — and the DTOs
 * that will live in `@running/contracts`, so replacing `bodyComposition.summary`
 * with a real `request('/api/body-composition/summary')` later touches nothing
 * in the screens.
 *
 * Two product rules are encoded in the types rather than left to the UI:
 *   - A body-fat figure is always a RANGE with a confidence label and a method.
 *     There is no single "your body fat is X" number anywhere in the model.
 *   - Photos and measurements belong to a session. The session is the unit of
 *     history, comparison and deletion.
 */

import type { ApiResult } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PhotoSide = 'front' | 'back' | 'left' | 'right';

/** Display order for the four-sided portrait. */
export const PHOTO_SIDES: readonly PhotoSide[] = ['front', 'back', 'left', 'right'];

export const PHOTO_SIDE_LABELS: Record<PhotoSide, string> = {
  front: 'Front',
  back: 'Back',
  left: 'Left',
  right: 'Right',
};

export type MeasurementUnit = 'cm' | 'in';

export type BodyFatMethod = 'formula' | 'ai';

export type AiServiceStatus = 'active' | 'unavailable' | 'failed';

export type ConfidenceLabel = 'low' | 'moderate' | 'high';

/** A place on the body the athlete measures with a tape. */
export interface CircumferencePoint {
  id: string;
  /** Stable code, e.g. `waist`, `left_arm`. */
  code: string;
  label: string;
  /** Where to put the tape, shown while measuring. */
  guideText: string;
  sortOrder: number;
}

export interface CompositionPhoto {
  id: string;
  side: PhotoSide;
  /** Server URL of the stored photo. Absent in the stub; the UI shows a placeholder. */
  uri?: string;
  capturedAt: string;
}

export interface BodyMeasurement {
  id: string;
  pointId: string;
  pointCode: string;
  pointLabel: string;
  value: number;
  unit: MeasurementUnit;
  capturedAt: string;
}

export interface BodyFatEstimate {
  id: string;
  method: BodyFatMethod;
  /** Lower bound of the confidence range, percent. */
  valueLow: number;
  /** Upper bound of the confidence range, percent. */
  valueHigh: number;
  confidenceLabel: ConfidenceLabel;
  /** Only meaningful for the `ai` method. */
  serviceStatus?: AiServiceStatus;
  createdAt: string;
}

export interface BodyCompositionSession {
  id: string;
  capturedAt: string;
  /** Local calendar date, `YYYY-MM-DD`. */
  localDate: string;
  photos: CompositionPhoto[];
  measurements: BodyMeasurement[];
  estimates: BodyFatEstimate[];
  /** Body weight at the time of the session, when one was recorded. */
  weightKilograms?: number;
}

export interface BodyCompositionSummary {
  /** The athlete's preferred tape unit. */
  defaultUnit: MeasurementUnit;
  points: CircumferencePoint[];
  /** Most recent session, if any. */
  latest?: BodyCompositionSession;
  /** Every session, newest first. */
  sessions: BodyCompositionSession[];
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

const CM_PER_INCH = 2.54;

export function convertCircumference(
  value: number,
  from: MeasurementUnit,
  to: MeasurementUnit,
): number {
  if (from === to) return value;
  return from === 'cm' ? value / CM_PER_INCH : value * CM_PER_INCH;
}

/** Format a tape measurement, e.g. `78.6 cm` or `30.9 in`. */
export function formatCircumference(value: number, unit: MeasurementUnit): string {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(1)} ${unit}`;
}

/** Format a body-fat estimate as its range, e.g. `15.8–17.6%`. */
export function formatBodyFatRange(
  estimate: Pick<BodyFatEstimate, 'valueLow' | 'valueHigh'>,
): string {
  return `${estimate.valueLow.toFixed(1)}–${estimate.valueHigh.toFixed(1)}%`;
}

export function formatBodyFatMethod(method: BodyFatMethod): string {
  return method === 'formula' ? 'Tape formula' : 'Photo AI';
}

/** Format a session's local date for display, e.g. `6 Sep 2026`. */
export function formatSessionDate(localDate: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${localDate}T12:00:00Z`));
  } catch {
    return localDate;
  }
}

/**
 * The estimate to headline for a session: the formula result when present,
 * because it is reproducible from the athlete's own numbers; otherwise the
 * latest AI result that actually produced a value.
 */
export function primaryEstimate(session: BodyCompositionSession): BodyFatEstimate | undefined {
  return (
    session.estimates.find((e) => e.method === 'formula') ??
    session.estimates.find((e) => e.method === 'ai' && e.serviceStatus === 'active')
  );
}

/** Measurement points shown on the summary card, in order. */
export const SUMMARY_POINT_CODES: readonly string[] = ['waist', 'chest', 'hips', 'left_arm'];

// ---------------------------------------------------------------------------
// Stub data
// ---------------------------------------------------------------------------

/**
 * The tape points the product supports. Guide text is what the athlete reads
 * while holding the tape, so it is specific about landmarks rather than vague.
 */
export const CIRCUMFERENCE_POINTS: CircumferencePoint[] = [
  {
    id: 'pt-neck',
    code: 'neck',
    label: 'Neck',
    guideText: 'Just below the larynx, tape sloping slightly downward to the front.',
    sortOrder: 1,
  },
  {
    id: 'pt-chest',
    code: 'chest',
    label: 'Chest',
    guideText: 'Around the fullest part of the chest, tape level, after a normal exhale.',
    sortOrder: 2,
  },
  {
    id: 'pt-waist',
    code: 'waist',
    label: 'Waist',
    guideText: 'At the navel, tape level, relaxed and after a normal exhale.',
    sortOrder: 3,
  },
  {
    id: 'pt-hips',
    code: 'hips',
    label: 'Hips',
    guideText: 'Around the widest part of the hips and glutes, feet together.',
    sortOrder: 4,
  },
  {
    id: 'pt-left-arm',
    code: 'left_arm',
    label: 'Left arm',
    guideText: 'Midway between shoulder and elbow, arm relaxed at your side.',
    sortOrder: 5,
  },
  {
    id: 'pt-right-arm',
    code: 'right_arm',
    label: 'Right arm',
    guideText: 'Midway between shoulder and elbow, arm relaxed at your side.',
    sortOrder: 6,
  },
  {
    id: 'pt-left-thigh',
    code: 'left_thigh',
    label: 'Left thigh',
    guideText: 'Just below the gluteal fold, standing with weight on both feet.',
    sortOrder: 7,
  },
  {
    id: 'pt-right-thigh',
    code: 'right_thigh',
    label: 'Right thigh',
    guideText: 'Just below the gluteal fold, standing with weight on both feet.',
    sortOrder: 8,
  },
];

/**
 * Twelve weeks of monthly sessions for a runner in a base block: waist and
 * hips drifting down, arms up a little, weight easing. Deliberately gradual —
 * the comparison and trend screens must cope with small, realistic deltas
 * rather than dramatic ones.
 */
const STUB_SESSIONS: {
  localDate: string;
  time: string;
  weightKilograms: number;
  cm: Record<string, number>;
  formula: [number, number];
  ai?: { range: [number, number]; status: AiServiceStatus };
}[] = [
  {
    localDate: '2026-09-06',
    time: '06:40:00',
    weightKilograms: 64.2,
    cm: {
      neck: 37.6,
      chest: 97.2,
      waist: 78.6,
      hips: 93.2,
      left_arm: 32.0,
      right_arm: 32.2,
      left_thigh: 55.0,
      right_thigh: 55.2,
    },
    formula: [15.8, 17.6],
    ai: { range: [15.0, 18.5], status: 'active' },
  },
  {
    localDate: '2026-08-09',
    time: '06:35:00',
    weightKilograms: 64.6,
    cm: {
      neck: 37.8,
      chest: 97.0,
      waist: 79.8,
      hips: 93.8,
      left_arm: 31.8,
      right_arm: 32.0,
      left_thigh: 55.2,
      right_thigh: 55.5,
    },
    formula: [16.3, 18.1],
    ai: { range: [0, 0], status: 'unavailable' },
  },
  {
    localDate: '2026-07-12',
    time: '06:50:00',
    weightKilograms: 65.0,
    cm: {
      neck: 38.0,
      chest: 96.5,
      waist: 81.0,
      hips: 94.4,
      left_arm: 31.5,
      right_arm: 31.8,
      left_thigh: 55.6,
      right_thigh: 55.9,
    },
    formula: [16.9, 18.7],
  },
  {
    localDate: '2026-06-14',
    time: '07:05:00',
    weightKilograms: 65.4,
    cm: {
      neck: 38.0,
      chest: 96.0,
      waist: 82.5,
      hips: 95.0,
      left_arm: 31.2,
      right_arm: 31.5,
      left_thigh: 56.0,
      right_thigh: 56.3,
    },
    formula: [17.4, 19.2],
  },
];

function buildStubSummary(): BodyCompositionSummary {
  const pointsByCode = new Map(CIRCUMFERENCE_POINTS.map((p) => [p.code, p]));

  const sessions: BodyCompositionSession[] = STUB_SESSIONS.map((stub, index) => {
    const id = `session-${stub.localDate}`;
    // Fixture timezone is UTC+7, matching the seed athlete.
    const capturedAt = new Date(`${stub.localDate}T${stub.time}+07:00`).toISOString();

    const measurements: BodyMeasurement[] = CIRCUMFERENCE_POINTS.flatMap((point) => {
      const value = stub.cm[point.code];
      if (value === undefined) return [];
      return [
        {
          id: `${id}-${point.code}`,
          pointId: point.id,
          pointCode: point.code,
          pointLabel: pointsByCode.get(point.code)?.label ?? point.code,
          value,
          unit: 'cm' as const,
          capturedAt,
        },
      ];
    });

    const estimates: BodyFatEstimate[] = [
      {
        id: `${id}-formula`,
        method: 'formula',
        valueLow: stub.formula[0],
        valueHigh: stub.formula[1],
        confidenceLabel: 'moderate',
        createdAt: capturedAt,
      },
    ];
    if (stub.ai) {
      estimates.push({
        id: `${id}-ai`,
        method: 'ai',
        valueLow: stub.ai.range[0],
        valueHigh: stub.ai.range[1],
        confidenceLabel: 'low',
        serviceStatus: stub.ai.status,
        createdAt: capturedAt,
      });
    }

    return {
      id,
      capturedAt,
      localDate: stub.localDate,
      // Photos are stored server-side; the stub carries no URLs, so the UI
      // renders labelled placeholders. `index` keeps ids unique across sessions.
      photos: PHOTO_SIDES.map((side) => ({
        id: `${id}-photo-${side}-${index}`,
        side,
        capturedAt,
      })),
      measurements,
      estimates,
      weightKilograms: stub.weightKilograms,
    };
  });

  return {
    defaultUnit: 'cm',
    points: [...CIRCUMFERENCE_POINTS].sort((a, b) => a.sortOrder - b.sortOrder),
    latest: sessions[0],
    sessions,
  };
}

/** Small artificial latency so loading states are visible during development. */
const STUB_LATENCY_MS = 250;

// ---------------------------------------------------------------------------
// Data source
// ---------------------------------------------------------------------------

/**
 * Body composition endpoints.
 *
 * Shaped like `api` in ./api.ts so the screens consume it identically. Backed
 * by the stub until the API routes exist.
 */
export const bodyComposition = {
  summary: async (): Promise<ApiResult<BodyCompositionSummary>> => {
    await new Promise((resolve) => setTimeout(resolve, STUB_LATENCY_MS));
    return { data: buildStubSummary(), fromCache: false };
  },
};
