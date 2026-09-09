/**
 * Body composition sessions, shaped for the API.
 *
 * A session row on its own says little. What the athlete sees is the session
 * plus its four photos, its tape measurements labelled from the catalog, and
 * the body-fat estimates derived from them. All of that is assembled here so
 * the summary, the history and the detail endpoints agree on what a session
 * looks like and never compute an estimate two different ways.
 *
 * Estimates are derived on read rather than stored: the formulas are
 * deterministic, so a corrected measurement changes the estimate with no
 * stale row to chase. Photo (AI) estimates, which do need storage, arrive in a
 * later phase.
 */

import { and, count, desc, eq, inArray } from 'drizzle-orm';

import type {
  BodyCompositionSessionDto,
  BodyCompositionSummaryDto,
  CreateBodyCompositionSessionDto,
  BodyFatEstimateDto,
  CircumferencePointDto,
  CompositionMeasurementDto,
  CompositionPhotoDto,
  MeasurementUnitDto,
} from '@running/contracts';
import {
  BODY_FAT_ESTIMATE_NOTE,
  PHOTO_SIDES,
  estimateBodyFat,
  isCircumferencePointCode,
  isMeasurementUnit,
  isPhotoSide,
  toLocalDate,
  type BiologicalSex,
  type BodyFatEstimate,
  type CircumferencePointCode,
} from '@running/core';

import type { Database } from '../db/client.js';
import {
  athleteProfiles,
  bodyCompositionSessions,
  bodyMeasurements,
  circumferencePoints,
  compositionMeasurements,
  compositionPhotos,
} from '../db/schema.js';
import { notFound } from '../errors.js';

/** Sessions returned with the summary; the history endpoint pages the rest. */
export const SUMMARY_SESSION_LIMIT = 12;

/** A logged weight this close to a session stands in for one the session lacks. */
const WEIGHT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

type SessionRow = typeof bodyCompositionSessions.$inferSelect;
type PhotoRow = typeof compositionPhotos.$inferSelect;
type MeasurementRow = typeof compositionMeasurements.$inferSelect;
type PointRow = typeof circumferencePoints.$inferSelect;
type BodyMetricRow = typeof bodyMeasurements.$inferSelect;

/** What the estimates need from outside the session itself. */
interface AthleteEstimateContext {
  sex: BiologicalSex;
  heightCm?: number;
  bodyMetrics: readonly BodyMetricRow[];
}

// ---------------------------------------------------------------------------
// Catalog and preferences
// ---------------------------------------------------------------------------

function toPointDto(row: PointRow): CircumferencePointDto {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    guideText: row.guideText,
    sortOrder: row.sortOrder,
  };
}

export async function loadCircumferenceCatalog(db: Database): Promise<CircumferencePointDto[]> {
  const rows = await db.select().from(circumferencePoints).orderBy(circumferencePoints.sortOrder);
  return rows.map(toPointDto);
}

/** The tape unit to default to, from the athlete's general unit preference. */
export function defaultUnitFor(units: string): MeasurementUnitDto {
  return units === 'imperial' ? 'in' : 'cm';
}

function toSex(value: string): BiologicalSex {
  return value === 'male' || value === 'female' ? value : 'unspecified';
}

async function loadEstimateContext(
  db: Database,
  athleteId: string,
): Promise<AthleteEstimateContext & { units: string }> {
  const [profile] = await db
    .select()
    .from(athleteProfiles)
    .where(eq(athleteProfiles.id, athleteId))
    .limit(1);
  if (!profile) throw notFound('Athlete');

  const bodyMetrics = await db
    .select()
    .from(bodyMeasurements)
    .where(eq(bodyMeasurements.athleteId, athleteId))
    .orderBy(desc(bodyMeasurements.measuredAt));

  // Height barely moves in adulthood, so the latest reading serves every session.
  const height = bodyMetrics.find((m) => m.metric === 'height_m');

  return {
    sex: toSex(profile.sex),
    heightCm: height ? height.normalizedValue * 100 : undefined,
    bodyMetrics,
    units: profile.units,
  };
}

/** The logged weight closest to `at`, if one falls inside the window. */
function nearestWeight(rows: readonly BodyMetricRow[], at: Date): number | undefined {
  let best: { distance: number; value: number } | undefined;
  for (const row of rows) {
    if (row.metric !== 'weight_kg') continue;
    const distance = Math.abs(row.measuredAt.getTime() - at.getTime());
    if (distance > WEIGHT_WINDOW_MS) continue;
    if (!best || distance < best.distance) best = { distance, value: row.normalizedValue };
  }
  return best?.value;
}

// ---------------------------------------------------------------------------
// Session shaping
// ---------------------------------------------------------------------------

/** Where the app fetches the bytes; served by the photo route, owner only. */
export function photoUrl(sessionId: string, side: string): string {
  return `/api/body-composition/sessions/${sessionId}/photos/${side}`;
}

export function toPhotoDto(row: PhotoRow): CompositionPhotoDto | undefined {
  if (!isPhotoSide(row.side)) return undefined;
  return {
    id: row.id,
    side: row.side,
    url: photoUrl(row.sessionId, row.side),
    capturedAt: row.capturedAt.toISOString(),
    contentType: row.contentType ?? undefined,
    widthPx: row.widthPx ?? undefined,
    heightPx: row.heightPx ?? undefined,
  };
}

function toMeasurementDto(row: MeasurementRow, point: PointRow): CompositionMeasurementDto {
  return {
    id: row.id,
    pointId: point.id,
    pointCode: point.code,
    pointLabel: point.label,
    value: row.value,
    unit: isMeasurementUnit(row.unit) ? row.unit : 'cm',
    valueCm: row.valueCm,
    capturedAt: row.capturedAt.toISOString(),
  };
}

function toEstimateDto(sessionId: string, estimate: BodyFatEstimate): BodyFatEstimateDto {
  return {
    // Derived, not stored: the id only has to be stable for a given session.
    id: `${sessionId}:${estimate.formula ?? estimate.method}`,
    method: estimate.method,
    formula: estimate.formula,
    variant: estimate.variant,
    value: estimate.value,
    valueLow: estimate.valueLow,
    valueHigh: estimate.valueHigh,
    confidence: estimate.confidence,
    confidenceReasons: estimate.confidenceReasons,
    inputs: estimate.inputs,
    steps: estimate.steps,
    note: estimate.note,
  };
}

function toSessionDto(
  row: SessionRow,
  photos: readonly PhotoRow[],
  measurements: readonly MeasurementRow[],
  pointsById: ReadonlyMap<string, PointRow>,
  context: AthleteEstimateContext,
): BodyCompositionSessionDto {
  const photoDtos = photos
    .map(toPhotoDto)
    .filter((p): p is CompositionPhotoDto => p !== undefined)
    .sort((a, b) => PHOTO_SIDES.indexOf(a.side) - PHOTO_SIDES.indexOf(b.side));

  const labelled = measurements
    .map((m) => {
      const point = pointsById.get(m.pointId);
      return point ? { row: m, point } : undefined;
    })
    .filter((m): m is { row: MeasurementRow; point: PointRow } => m !== undefined)
    .sort((a, b) => a.point.sortOrder - b.point.sortOrder);

  const circumferencesCm: Partial<Record<CircumferencePointCode, number>> = {};
  for (const { row: m, point } of labelled) {
    if (isCircumferencePointCode(point.code)) circumferencesCm[point.code] = m.valueCm;
  }

  const weightKilograms =
    row.weightKilograms ?? nearestWeight(context.bodyMetrics, row.capturedAt) ?? undefined;

  const assessment = estimateBodyFat({
    sex: context.sex,
    heightCm: context.heightCm,
    weightKg: weightKilograms,
    circumferencesCm,
  });

  return {
    id: row.id,
    capturedAt: row.capturedAt.toISOString(),
    localDate: row.localDate,
    weightKilograms: row.weightKilograms ?? undefined,
    note: row.note ?? undefined,
    photos: photoDtos,
    measurements: labelled.map(({ row: m, point }) => toMeasurementDto(m, point)),
    estimates: assessment.estimates.map((e) => toEstimateDto(row.id, e)),
    estimateRequirements: assessment.unavailable,
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Sessions for one athlete, newest first, each with photos, labelled
 * measurements and derived estimates. Only rows owned by `athleteId` are ever
 * read: the session ids are used to fetch children, never trusted on their own.
 */
export async function loadSessions(
  db: Database,
  athleteId: string,
  options: { limit?: number; sessionId?: string } = {},
): Promise<BodyCompositionSessionDto[]> {
  const context = await loadEstimateContext(db, athleteId);

  const query = db
    .select()
    .from(bodyCompositionSessions)
    .where(
      and(
        eq(bodyCompositionSessions.athleteId, athleteId),
        options.sessionId ? eq(bodyCompositionSessions.id, options.sessionId) : undefined,
      ),
    )
    .orderBy(desc(bodyCompositionSessions.capturedAt), desc(bodyCompositionSessions.createdAt));
  const rows = options.limit === undefined ? await query : await query.limit(options.limit);
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const photos = await db
    .select()
    .from(compositionPhotos)
    .where(inArray(compositionPhotos.sessionId, ids));
  const measurements = await db
    .select()
    .from(compositionMeasurements)
    .where(inArray(compositionMeasurements.sessionId, ids));
  const points = await db.select().from(circumferencePoints);
  const pointsById = new Map(points.map((p) => [p.id, p]));

  return rows.map((row) =>
    toSessionDto(
      row,
      photos.filter((p) => p.sessionId === row.id),
      measurements.filter((m) => m.sessionId === row.id),
      pointsById,
      context,
    ),
  );
}

/** The summary screen's payload: catalog, default unit, latest and recent sessions. */
export async function buildSummary(
  db: Database,
  athleteId: string,
): Promise<BodyCompositionSummaryDto> {
  const context = await loadEstimateContext(db, athleteId);
  const points = await loadCircumferenceCatalog(db);
  const sessions = await loadSessions(db, athleteId, { limit: SUMMARY_SESSION_LIMIT });

  const [totals] = await db
    .select({ total: count() })
    .from(bodyCompositionSessions)
    .where(eq(bodyCompositionSessions.athleteId, athleteId));

  return {
    defaultUnit: defaultUnitFor(context.units),
    points,
    latest: sessions[0],
    sessions,
    sessionCount: totals?.total ?? 0,
    note: BODY_FAT_ESTIMATE_NOTE,
  };
}

/** One session, or undefined when it does not exist or belongs to someone else. */
export async function loadSession(
  db: Database,
  athleteId: string,
  sessionId: string,
): Promise<BodyCompositionSessionDto | undefined> {
  const [session] = await loadSessions(db, athleteId, { sessionId, limit: 1 });
  return session;
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

/**
 * Start a session. Photos and measurements attach to it afterwards, side by
 * side and point by point, so the athlete can retake one side without
 * starting over. The local date comes from the profile's timezone, like a
 * training day.
 */
export async function createSession(
  db: Database,
  athleteId: string,
  input: CreateBodyCompositionSessionDto,
): Promise<BodyCompositionSessionDto> {
  const [profile] = await db
    .select({ timezone: athleteProfiles.timezone })
    .from(athleteProfiles)
    .where(eq(athleteProfiles.id, athleteId))
    .limit(1);
  if (!profile) throw notFound('Athlete');

  const capturedAt = input.capturedAt ? new Date(input.capturedAt) : new Date();
  const [row] = await db
    .insert(bodyCompositionSessions)
    .values({
      athleteId,
      capturedAt,
      localDate: toLocalDate(capturedAt, profile.timezone || 'UTC'),
      weightKilograms: input.weightKilograms,
      note: input.note,
    })
    .returning();

  const session = await loadSession(db, athleteId, row!.id);
  if (!session) throw notFound('Session');
  return session;
}
