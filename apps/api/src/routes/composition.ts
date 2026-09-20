/**
 * Body composition routes.
 *
 * Photos arrive as multipart rather than base64 in JSON: a 12 MB body photo
 * base64'd inflates by a third and has to be held in memory as a string before
 * anything can be written, four times over for one session.
 *
 * Ordering is the part worth reading. Every file is validated before any is
 * stored, then all four are stored, then the rows are written in one
 * transaction — and a failed transaction deletes the files it wrote. The
 * failure mode that leaves is orphaned bytes on disk, which are invisible and
 * collectable. The alternative ordering leaves a row pointing at a photo that
 * does not exist, which is a broken screen the athlete cannot fix.
 */

import { Hono } from 'hono';
import { and, asc, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';

import {
  PHOTO_SIDES,
  compareSessionsQuerySchema,
  createCompositionSessionSchema,
  calculateBodyFatSchema,
  recordMeasurementSchema,
  recordMeasurementsSchema,
  type BodyFatEstimateDto,
  type BodyFatHistoryDto,
  type ComparisonOptionDto,
  type PhotoPairDto,
  type SessionComparisonDto,
  type TrendSeriesDto,
  type MetricHistoryDto,
  type CompositionMeasurementDto,
  type CompositionPhotoDto,
  type CompositionSessionDto,
  type LengthUnitDto,
  type PhotoSideDto,
} from '@running/contracts';
import {
  TAPE_REPEATABILITY_CM,
  changeDirection,
  estimateBodyFat,
  withChanges as withChangesCore,
  toCanonicalLength,
  toCanonicalMass,
  withChanges,
  type LengthUnit,
  type MassUnit,
} from '@running/core';
import { toLocalDate } from '@running/core';

import { getDb } from '../db/client.js';
import {
  athleteProfiles,
  bodyCompositionSessions,
  bodyFatEstimates,
  bodyMeasurements,
  circumferencePoints,
  compositionMeasurements,
  compositionPhotos,
} from '../db/schema.js';
import { API_ERROR_CODES } from '@running/contracts';
import { ApiError, badRequest, notFound } from '../errors.js';
import { logger } from '../observability/logger.js';
import {
  photoStorage,
  validatePhotoUpload,
  type PhotoSide,
  type StoredPhoto,
} from '../services/photo-storage.js';
import { PHOTO_MARGIN, analysePhotos, visionStatus } from '../services/vision.js';
import type { AuthVariables } from '../security/auth.js';

// Authentication is applied centrally in app.ts; see the PUBLIC_PATHS note there.
export const compositionRoutes = new Hono<{ Variables: AuthVariables }>();

/** Route that serves a photo's bytes. Clients never see a storage key. */
function photoUrl(sessionId: string, photoId: string): string {
  return `/api/composition/sessions/${sessionId}/photos/${photoId}`;
}

/** Position of each side in the order the app lays the set out. */
const SIDE_ORDER = new Map(PHOTO_SIDES.map((side, index) => [side as string, index]));

interface SessionRow {
  id: string;
  capturedAt: Date;
  localDate: string;
  note: string | null;
}

interface PhotoRow {
  id: string;
  sessionId: string;
  side: string;
  contentType: string;
  byteSize: number;
  capturedAt: Date;
}

interface MeasurementRow {
  id: string;
  sessionId: string;
  pointId: string;
  pointCode: string;
  valueCm: number;
  recordedUnit: string;
  capturedAt: Date;
}

function toMeasurementDto(measurement: MeasurementRow): CompositionMeasurementDto {
  return {
    id: measurement.id,
    pointId: measurement.pointId,
    pointCode: measurement.pointCode,
    valueCm: measurement.valueCm,
    recordedUnit: measurement.recordedUnit as LengthUnitDto,
    capturedAt: measurement.capturedAt.toISOString(),
  };
}

function toPhotoDto(photo: PhotoRow): CompositionPhotoDto {
  return {
    id: photo.id,
    side: photo.side as PhotoSideDto,
    contentType: photo.contentType,
    byteSize: photo.byteSize,
    capturedAt: photo.capturedAt.toISOString(),
    url: photoUrl(photo.sessionId, photo.id),
  };
}

/**
 * Shape one session for the wire.
 *
 * Photos come back in front/back/left/right order rather than however the rows
 * happened to be written, so the app can lay the set out the same way every
 * time — including for a session where one side was retaken and its row is
 * newer than the rest.
 */
function toSessionDto(
  session: SessionRow,
  photos: readonly PhotoRow[],
  measurements: readonly MeasurementRow[] = [],
): CompositionSessionDto {
  return {
    id: session.id,
    capturedAt: session.capturedAt.toISOString(),
    localDate: session.localDate,
    ...(session.note ? { note: session.note } : {}),
    photos: [...photos]
      .sort((a, b) => (SIDE_ORDER.get(a.side) ?? 99) - (SIDE_ORDER.get(b.side) ?? 99))
      .map(toPhotoDto),
    measurements: measurements.map(toMeasurementDto),
  };
}

/** Everything in the form that is not a file. */
function readMetadata(form: FormData): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string' && value !== '') fields[key] = value;
  }
  return fields;
}

compositionRoutes.post('/sessions', async (c) => {
  const athleteId = c.get('athleteId');

  // Read the body once; formData() cannot be called twice on one request.
  const form = await c.req.raw.formData().catch(() => {
    throw badRequest('Send the photos as a multipart form.');
  });

  const parsed = createCompositionSessionSchema.safeParse(readMetadata(form));
  if (!parsed.success) throw badRequest('Some of the session details were not valid.');

  /**
   * All four sides are required.
   *
   * A session documenting three sides cannot be compared against one
   * documenting four, and letting a partial set through pushes that problem
   * into every screen that reads it. Retaking a single side is a separate
   * operation on an existing session, not a partial create.
   */
  const files = new Map<PhotoSide, File>();
  const missing: string[] = [];
  for (const side of PHOTO_SIDES) {
    const part = form.get(side);
    if (!(part instanceof File) || part.size === 0) missing.push(side);
    else files.set(side, part);
  }
  if (missing.length > 0) {
    throw badRequest(`A session needs all four photos. Still missing: ${missing.join(', ')}.`, {
      missing,
    });
  }

  const storage = photoStorage();
  const { db } = await getDb();

  const [profile] = await db
    .select()
    .from(athleteProfiles)
    .where(eq(athleteProfiles.id, athleteId))
    .limit(1);

  const capturedAt = parsed.data.capturedAt ? new Date(parsed.data.capturedAt) : new Date();
  if (Number.isNaN(capturedAt.getTime())) throw badRequest('That capture time is not valid.');

  const localDate = parsed.data.localDate ?? toLocalDate(capturedAt, profile?.timezone ?? 'UTC');

  const payloads = new Map<PhotoSide, { bytes: Uint8Array; contentType: string }>();
  for (const [side, file] of files) {
    payloads.set(side, {
      bytes: new Uint8Array(await file.arrayBuffer()),
      contentType: file.type,
    });
  }

  // Check every file before a single byte is written. A set with one bad photo
  // is rejected whole, with nothing left behind to clean up — rather than
  // writing the good ones and relying on the cleanup path below to undo them.
  // `put` validates again for its own sake; the cost is a few byte comparisons
  // and it keeps the storage service safe for any caller.
  for (const payload of payloads.values()) validatePhotoUpload(payload);

  const sessionId = crypto.randomUUID();
  const stored = new Map<PhotoSide, StoredPhoto>();

  try {
    for (const [side, payload] of payloads) {
      stored.set(
        side,
        await storage.put({
          athleteId,
          sessionId,
          side,
          contentType: payload.contentType,
          bytes: payload.bytes,
        }),
      );
    }

    const photos = await db.transaction(async (tx) => {
      await tx.insert(bodyCompositionSessions).values({
        id: sessionId,
        athleteId,
        capturedAt,
        localDate,
        note: parsed.data.note ?? null,
      });

      return tx
        .insert(compositionPhotos)
        .values(
          [...stored].map(([side, photo]) => ({
            sessionId,
            side,
            storageKey: photo.storageKey,
            contentType: photo.contentType,
            byteSize: photo.byteSize,
            capturedAt,
          })),
        )
        .returning();
    });

    const body = toSessionDto(
      { id: sessionId, capturedAt, localDate, note: parsed.data.note ?? null },
      photos,
    );

    logger.info('composition.session_created', { sessionId, photos: body.photos.length });
    return c.json(body, 201);
  } catch (error) {
    // Whatever went wrong, do not leave files behind for a session that has no
    // row. Cleanup failing is logged, not surfaced: the athlete's request
    // already failed and a second error about our own housekeeping helps
    // nobody.
    await storage.removeSession(athleteId, sessionId).catch((cleanupError: unknown) => {
      logger.error('composition.cleanup_failed', {
        sessionId,
        error: String(cleanupError),
      });
    });
    throw error;
  }
});

/**
 * The athlete's sessions, newest first.
 *
 * Scoped to the caller's athlete id in the query itself, not filtered after
 * the fact — a list endpoint is exactly where another athlete's body photos
 * would leak if the scope lived anywhere but the WHERE clause.
 *
 * Photos are fetched in one query keyed by the session ids actually loaded.
 * Both alternatives are worse: a query per session is N+1, and reading the
 * whole photo table to group it in memory grows with every athlete on the
 * instance rather than with the page being served.
 */
compositionRoutes.get('/sessions', async (c) => {
  const athleteId = c.get('athleteId');

  const requested = Number(c.req.query('limit') ?? 20);
  // A non-numeric limit falls back rather than turning the query into NaN.
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 100) : 20;

  const { db } = await getDb();

  const sessions = await db
    .select()
    .from(bodyCompositionSessions)
    .where(eq(bodyCompositionSessions.athleteId, athleteId))
    .orderBy(desc(bodyCompositionSessions.capturedAt))
    .limit(limit);

  if (sessions.length === 0) return c.json({ sessions: [] });

  const photos = await db
    .select()
    .from(compositionPhotos)
    .where(
      inArray(
        compositionPhotos.sessionId,
        sessions.map((session) => session.id),
      ),
    );

  // Joined so each measurement carries its point's code; the client keys on
  // the code, never on a uuid that differs between environments.
  const measurementRows = await db
    .select({
      id: compositionMeasurements.id,
      sessionId: compositionMeasurements.sessionId,
      pointId: compositionMeasurements.pointId,
      pointCode: circumferencePoints.code,
      sortOrder: circumferencePoints.sortOrder,
      valueCm: compositionMeasurements.valueCm,
      recordedUnit: compositionMeasurements.recordedUnit,
      capturedAt: compositionMeasurements.capturedAt,
    })
    .from(compositionMeasurements)
    .innerJoin(circumferencePoints, eq(compositionMeasurements.pointId, circumferencePoints.id))
    .where(
      inArray(
        compositionMeasurements.sessionId,
        sessions.map((session) => session.id),
      ),
    )
    // Anatomical order, so the app lists a session the same way every time.
    .orderBy(asc(circumferencePoints.sortOrder));

  const photosBySession = new Map<string, PhotoRow[]>();
  for (const photo of photos) {
    const list = photosBySession.get(photo.sessionId) ?? [];
    list.push(photo);
    photosBySession.set(photo.sessionId, list);
  }

  const measurementsBySession = new Map<string, MeasurementRow[]>();
  for (const measurement of measurementRows) {
    const list = measurementsBySession.get(measurement.sessionId) ?? [];
    list.push(measurement);
    measurementsBySession.set(measurement.sessionId, list);
  }

  return c.json({
    sessions: sessions.map((session) =>
      toSessionDto(
        session,
        photosBySession.get(session.id) ?? [],
        measurementsBySession.get(session.id) ?? [],
      ),
    ),
  });
});

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

/**
 * Find a session the caller owns.
 *
 * Ownership lives in the same query as the lookup. A session that belongs to
 * someone else is reported as not found, never as forbidden: telling an athlete
 * "that exists but is not yours" turns a list of uuids into a way to discover
 * which ones are real.
 */
async function ownedSession(
  db: Awaited<ReturnType<typeof getDb>>['db'],
  athleteId: string,
  sessionId: string,
): Promise<SessionRow> {
  const [session] = await db
    .select()
    .from(bodyCompositionSessions)
    .where(
      and(
        eq(bodyCompositionSessions.id, sessionId),
        eq(bodyCompositionSessions.athleteId, athleteId),
      ),
    )
    .limit(1);

  if (!session) throw notFound('Session');
  return session;
}

/**
 * Record circumferences into a session, replacing any already there.
 *
 * The request carries what the athlete typed — a value and the unit they read
 * it in — and the conversion to canonical centimetres happens here, once. A
 * client that converts wrongly therefore cannot write a corrupted canonical
 * value, and `recordedUnit` keeps what they actually read so the app can show
 * it back to them unchanged.
 *
 * Writing is an upsert on (session, point): re-measuring after the tape slipped
 * replaces the earlier number rather than leaving the session holding two
 * answers to one question. That is the same rule the unique index enforces, so
 * the endpoint cannot drift from the database.
 */
compositionRoutes.post('/sessions/:sessionId/measurements', async (c) => {
  const athleteId = c.get('athleteId');
  const sessionId = c.req.param('sessionId');

  // Authorize before validating, as the correction endpoint does: a caller
  // with no claim on this session gets the same answer whatever they sent.
  const { db } = await getDb();
  const session = await ownedSession(db, athleteId, sessionId);

  const parsed = recordMeasurementsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw badRequest(
      parsed.error.issues[0]?.message ?? 'Some of those measurements were not valid.',
      { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
    );
  }

  // Resolve codes to ids in one query. An unknown code is the athlete's client
  // being out of date, so it is named rather than silently dropped.
  const codes = parsed.data.measurements.map((measurement) => measurement.pointCode);
  const points = await db
    .select()
    .from(circumferencePoints)
    .where(inArray(circumferencePoints.code, codes));

  const byCode = new Map(points.map((point) => [point.code, point]));
  const unknown = codes.filter((code) => !byCode.has(code));
  if (unknown.length > 0) {
    throw badRequest(`Unknown measure point: ${unknown.join(', ')}.`, { unknown });
  }

  const values = parsed.data.measurements.map((measurement) => ({
    sessionId,
    pointId: byCode.get(measurement.pointCode)!.id,
    valueCm: toCanonicalLength(measurement.value, measurement.unit as LengthUnit),
    recordedUnit: measurement.unit,
    // Defaults to the session's own capture time, not now: a correction made
    // months later must not restamp the reading with the time of the fix.
    capturedAt: measurement.capturedAt ? new Date(measurement.capturedAt) : session.capturedAt,
  }));

  await db
    .insert(compositionMeasurements)
    .values(values)
    .onConflictDoUpdate({
      target: [compositionMeasurements.sessionId, compositionMeasurements.pointId],
      set: {
        valueCm: sql`excluded.value_cm`,
        recordedUnit: sql`excluded.recorded_unit`,
        capturedAt: sql`excluded.captured_at`,
        updatedAt: new Date(),
      },
    });

  return c.json({ measurements: await sessionMeasurements(db, sessionId) });
});

/** Every measurement in one session, in anatomical order, with point codes. */
async function sessionMeasurements(
  db: Awaited<ReturnType<typeof getDb>>['db'],
  sessionId: string,
): Promise<CompositionMeasurementDto[]> {
  const rows = await db
    .select({
      id: compositionMeasurements.id,
      sessionId: compositionMeasurements.sessionId,
      pointId: compositionMeasurements.pointId,
      pointCode: circumferencePoints.code,
      valueCm: compositionMeasurements.valueCm,
      recordedUnit: compositionMeasurements.recordedUnit,
      capturedAt: compositionMeasurements.capturedAt,
    })
    .from(compositionMeasurements)
    .innerJoin(circumferencePoints, eq(compositionMeasurements.pointId, circumferencePoints.id))
    .where(eq(compositionMeasurements.sessionId, sessionId))
    .orderBy(asc(circumferencePoints.sortOrder));

  return rows.map(toMeasurementDto);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * One measure point's values over time, newest first.
 *
 * Each entry carries its change from the session before it, computed in
 * canonical centimetres by `@running/core` — the same function the app uses, so
 * the delta on the phone and the delta from the server are the same number by
 * construction rather than by two implementations agreeing for now.
 *
 * One extra row is fetched beyond the page. The oldest entry *on the page* has
 * a predecessor in the database, and it deserves its change: without the extra
 * row a value's delta would appear or vanish depending on where the page
 * boundary happened to fall.
 *
 * Sessions that did not measure this point are simply absent from the join, so
 * skipping the neck for two months leaves a gap in time rather than a run of
 * rows claiming it measured nothing.
 */
compositionRoutes.get('/points/:code/history', async (c) => {
  const athleteId = c.get('athleteId');
  const code = c.req.param('code');

  const requested = Number(c.req.query('limit') ?? 24);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 200) : 24;

  const { db } = await getDb();

  const [point] = await db
    .select()
    .from(circumferencePoints)
    .where(eq(circumferencePoints.code, code))
    .limit(1);

  if (!point) throw notFound('Measure point');

  const rows = await db
    .select({
      sessionId: bodyCompositionSessions.id,
      capturedAt: bodyCompositionSessions.capturedAt,
      localDate: bodyCompositionSessions.localDate,
      valueCm: compositionMeasurements.valueCm,
      recordedUnit: compositionMeasurements.recordedUnit,
    })
    .from(compositionMeasurements)
    .innerJoin(
      bodyCompositionSessions,
      eq(compositionMeasurements.sessionId, bodyCompositionSessions.id),
    )
    .where(
      and(
        eq(compositionMeasurements.pointId, point.id),
        eq(bodyCompositionSessions.athleteId, athleteId),
      ),
    )
    .orderBy(desc(bodyCompositionSessions.capturedAt))
    // One beyond the page, so the last entry on it still gets its change.
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const behind = rows[limit];

  const entries = withChanges(
    page.map((row) => ({
      sessionId: row.sessionId,
      capturedAt: row.capturedAt.toISOString(),
      localDate: row.localDate,
      valueCm: row.valueCm,
      recordedUnit: row.recordedUnit as LengthUnitDto,
    })),
    behind ? { capturedAt: behind.capturedAt.toISOString(), valueCm: behind.valueCm } : undefined,
  );

  const body: MetricHistoryDto = {
    point: {
      id: point.id,
      code: point.code,
      label: point.label,
      guideText: point.guideText,
      sortOrder: point.sortOrder,
    },
    entries,
  };

  return c.json(body);
});

/**
 * Resolve a measure point by its code, or say it does not exist.
 *
 * Codes, not uuids, in every path an athlete's client builds: a uuid differs
 * between environments and turns a bookmarked URL into a 404 after a restore.
 */
async function pointByCode(
  db: Awaited<ReturnType<typeof getDb>>['db'],
  code: string,
): Promise<{ id: string; code: string; label: string }> {
  const [point] = await db
    .select()
    .from(circumferencePoints)
    .where(eq(circumferencePoints.code, code))
    .limit(1);

  if (!point) throw notFound('Measure point');
  return point;
}

/**
 * Correct a value already recorded in a session.
 *
 * Validated by the same schema the create path uses, with the point code taken
 * from the URL — so the plausible-range check cannot drift between recording a
 * measurement and fixing one.
 *
 * A point with nothing recorded is a 404 rather than an implicit create. The
 * client asking to correct a measurement believes one is there; if it is not,
 * its view is stale and quietly inventing a reading would hide that.
 *
 * `capturedAt` is left alone unless the caller explicitly supplies one. It
 * records when the athlete stood there with the tape, and fixing a digit typed
 * wrong does not move that moment — restamping would file a June measurement
 * under September and corrupt every trend built on it.
 */
compositionRoutes.patch('/sessions/:sessionId/measurements/:pointCode', async (c) => {
  const athleteId = c.get('athleteId');
  const sessionId = c.req.param('sessionId');

  // Authorize before validating. A caller with no claim on this session gets
  // the same answer whatever they sent, and we do not spend work parsing a
  // payload on behalf of someone who cannot act on it either way.
  const { db } = await getDb();
  await ownedSession(db, athleteId, sessionId);
  const point = await pointByCode(db, c.req.param('pointCode'));

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = recordMeasurementSchema.safeParse({ ...body, pointCode: point.code });
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'That measurement was not valid.', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }

  const updated = await db
    .update(compositionMeasurements)
    .set({
      valueCm: toCanonicalLength(parsed.data.value, parsed.data.unit as LengthUnit),
      recordedUnit: parsed.data.unit,
      ...(parsed.data.capturedAt ? { capturedAt: new Date(parsed.data.capturedAt) } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(compositionMeasurements.sessionId, sessionId),
        eq(compositionMeasurements.pointId, point.id),
      ),
    )
    .returning();

  if (updated.length === 0) throw notFound('Measurement');

  return c.json({ measurements: await sessionMeasurements(db, sessionId) });
});

/**
 * Remove a value from a session.
 *
 * Reports whether anything was actually removed instead of failing when there
 * was nothing there, so a retry after a dropped connection is harmless. The
 * session survives losing its last circumference: it may still hold photos, and
 * discarding a whole session is a separate, deliberate action rather than a
 * side effect of deleting one number.
 */
compositionRoutes.delete('/sessions/:sessionId/measurements/:pointCode', async (c) => {
  const athleteId = c.get('athleteId');
  const sessionId = c.req.param('sessionId');

  const { db } = await getDb();
  await ownedSession(db, athleteId, sessionId);
  const point = await pointByCode(db, c.req.param('pointCode'));

  const removed = await db
    .delete(compositionMeasurements)
    .where(
      and(
        eq(compositionMeasurements.sessionId, sessionId),
        eq(compositionMeasurements.pointId, point.id),
      ),
    )
    .returning();

  return c.json({
    ok: true,
    deleted: removed.length > 0,
    measurements: await sessionMeasurements(db, sessionId),
  });
});

// ---------------------------------------------------------------------------
// Body fat
// ---------------------------------------------------------------------------

/** Circumferences a session holds, keyed by measure point code. */
async function sessionCircumferences(
  db: Awaited<ReturnType<typeof getDb>>['db'],
  sessionId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ code: circumferencePoints.code, valueCm: compositionMeasurements.valueCm })
    .from(compositionMeasurements)
    .innerJoin(circumferencePoints, eq(compositionMeasurements.pointId, circumferencePoints.id))
    .where(eq(compositionMeasurements.sessionId, sessionId));

  return new Map(rows.map((row) => [row.code, row.valueCm]));
}

interface EstimateRow {
  id: string;
  sessionId: string;
  method: string;
  valueLow: number;
  valueHigh: number;
  confidenceLabel: string;
  serviceStatus: string | null;
  basis: string;
  calculation: unknown;
  createdAt: Date;
}

function toEstimateDto(row: EstimateRow): BodyFatEstimateDto {
  const calculation = row.calculation as { steps?: BodyFatEstimateDto['steps'] } | null;

  return {
    id: row.id,
    sessionId: row.sessionId,
    method: row.method as BodyFatEstimateDto['method'],
    valueLow: row.valueLow,
    valueHigh: row.valueHigh,
    confidence: row.confidenceLabel as BodyFatEstimateDto['confidence'],
    ...(row.serviceStatus
      ? { serviceStatus: row.serviceStatus as NonNullable<BodyFatEstimateDto['serviceStatus']> }
      : {}),
    basis: row.basis,
    ...(calculation?.steps ? { steps: calculation.steps } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Run a circumference equation over a session and store the result.
 *
 * The circumferences are never sent by the client — they are already on the
 * session, and accepting them on the wire would let a caller compute an
 * estimate from numbers that are not in their own record.
 *
 * Height and weight arrive as the athlete entered them, with their unit, and
 * are converted here. That keeps the conversion in one place and means a client
 * that converts wrongly cannot write a corrupted canonical value.
 *
 * A failure to calculate is a 400 carrying the reason and the steps completed
 * before it stopped. "Waist minus neck came out negative" tells the athlete
 * which measurement to check; "could not calculate" tells them nothing.
 */
compositionRoutes.post('/sessions/:sessionId/body-fat', async (c) => {
  const athleteId = c.get('athleteId');
  const sessionId = c.req.param('sessionId');

  const { db } = await getDb();
  await ownedSession(db, athleteId, sessionId);

  const parsed = calculateBodyFatSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Those inputs were not valid.', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }

  const circumferences = await sessionCircumferences(db, sessionId);
  const waistCm = circumferences.get('waist');
  if (waistCm === undefined) {
    throw badRequest(
      'This session has no waist measurement, and every circumference equation reads one.',
    );
  }

  const heightCm = parsed.data.height
    ? toCanonicalLength(parsed.data.height.value, parsed.data.height.unit as LengthUnit)
    : undefined;
  const weightKg = parsed.data.weight
    ? toCanonicalMass(parsed.data.weight.value, parsed.data.weight.unit as MassUnit)
    : undefined;

  const result = estimateBodyFat(parsed.data.method, {
    variant: parsed.data.variant,
    waistCm,
    ...(circumferences.has('neck') ? { neckCm: circumferences.get('neck')! } : {}),
    ...(circumferences.has('hips') ? { hipsCm: circumferences.get('hips')! } : {}),
    ...(heightCm !== undefined ? { heightCm } : {}),
    ...(weightKg !== undefined ? { weightKg } : {}),
  });

  if (!result.ok) {
    // The steps travel with the refusal so the athlete can see where it
    // stopped rather than being told only that it did.
    throw badRequest(result.reason, { steps: result.steps });
  }

  const basis =
    parsed.data.method === 'navy'
      ? "US Navy equation from this session's circumferences and the height given."
      : "YMCA equation from this session's waist and the weight given.";

  const [row] = await db
    .insert(bodyFatEstimates)
    .values({
      sessionId,
      method: parsed.data.method,
      valueLow: result.valueLow,
      valueHigh: result.valueHigh,
      // Never higher than moderate. Nothing available here measures body fat;
      // a complete set of inputs makes the estimate usable, not certain.
      confidenceLabel: 'moderate',
      basis,
      calculation: {
        variant: result.variant,
        standardError: result.standardError,
        steps: result.steps,
      },
    })
    // Re-running on the same session replaces: the same inputs through the
    // same equation give the same answer, so a second row is a duplicate.
    .onConflictDoUpdate({
      target: [bodyFatEstimates.sessionId, bodyFatEstimates.method],
      set: {
        valueLow: result.valueLow,
        valueHigh: result.valueHigh,
        confidenceLabel: 'moderate',
        basis,
        calculation: {
          variant: result.variant,
          standardError: result.standardError,
          steps: result.steps,
        },
        updatedAt: new Date(),
      },
    })
    .returning();

  logger.info('composition.body_fat_estimated', { sessionId, method: parsed.data.method });
  return c.json(toEstimateDto(row!), 201);
});

/** Every estimate stored for a session, both methods and the photo path. */
compositionRoutes.get('/sessions/:sessionId/body-fat', async (c) => {
  const athleteId = c.get('athleteId');
  const sessionId = c.req.param('sessionId');

  const { db } = await getDb();
  await ownedSession(db, athleteId, sessionId);

  const rows = await db
    .select()
    .from(bodyFatEstimates)
    .where(eq(bodyFatEstimates.sessionId, sessionId))
    .orderBy(asc(bodyFatEstimates.method));

  return c.json({ estimates: rows.map(toEstimateDto) });
});

/**
 * What the photo-reading service can do right now.
 *
 * Returns a status, a sentence the app can show verbatim, and whether to point
 * the athlete at the formula instead. Nothing about keys, hosts or providers
 * crosses the wire — an athlete needs to know whether it works and what to do
 * if it does not, and nothing else.
 */
compositionRoutes.get('/vision/status', (c) => c.json(visionStatus()));

/**
 * Read a session's photos and store the estimate.
 *
 * **One reading per session.** If an estimate already exists it is returned
 * unchanged rather than the photographs being read again. The same images
 * through the same model give the same answer, so a second run would be noise
 * presented as new information — and it would spend the athlete's money and
 * send their body photos off the server a second time for nothing.
 *
 * Only the images leave this server. No name, no athlete id, no measurements,
 * no training history: the service is asked to look at pictures, and nothing it
 * receives would identify whose they are.
 */
compositionRoutes.post('/sessions/:sessionId/body-fat/photo', async (c) => {
  const athleteId = c.get('athleteId');
  const sessionId = c.req.param('sessionId');

  const { db } = await getDb();
  await ownedSession(db, athleteId, sessionId);

  const [existing] = await db
    .select()
    .from(bodyFatEstimates)
    .where(and(eq(bodyFatEstimates.sessionId, sessionId), eq(bodyFatEstimates.method, 'ai')))
    .limit(1);

  if (existing) {
    // Already read. Hand back what we have rather than paying to be told the
    // same thing twice.
    c.header('x-composition-cached', 'true');
    return c.json(toEstimateDto(existing));
  }

  const status = visionStatus();
  if (status.status !== 'active') {
    throw new ApiError(503, API_ERROR_CODES.PROVIDER_UNAVAILABLE, status.message, {
      serviceStatus: status.status,
      suggestFormula: status.suggestFormula,
    });
  }

  const photoRows = await db
    .select()
    .from(compositionPhotos)
    .where(eq(compositionPhotos.sessionId, sessionId));

  if (photoRows.length === 0) {
    throw badRequest(
      'This session has no photos to read. Take a set, or use the measurements method.',
    );
  }

  const storage = photoStorage();
  const photos: { side: string; contentType: string; bytes: Buffer }[] = [];

  for (const row of photoRows) {
    const file = await storage.read(row.storageKey);
    // A row whose bytes are missing is skipped rather than failing the whole
    // read: three usable sides still produce a usable answer.
    if (file) photos.push({ side: row.side, contentType: file.contentType, bytes: file.bytes });
  }

  if (photos.length === 0) {
    throw badRequest('None of this session photos could be opened.');
  }

  const reading = await analysePhotos(photos);

  if (!reading.ok) {
    const after = visionStatus();
    throw new ApiError(502, API_ERROR_CODES.PROVIDER_UNAVAILABLE, reading.reason, {
      serviceStatus: after.status,
      suggestFormula: true,
    });
  }

  const [row] = await db
    .insert(bodyFatEstimates)
    .values({
      sessionId,
      method: 'ai',
      valueLow: reading.valueLow,
      valueHigh: reading.valueHigh,
      // A photograph is the weakest signal on offer and never earns more.
      confidenceLabel: 'low',
      serviceStatus: 'active',
      basis: reading.note,
      calculation: { margin: PHOTO_MARGIN, sides: photos.map((photo) => photo.side) },
    })
    .onConflictDoUpdate({
      target: [bodyFatEstimates.sessionId, bodyFatEstimates.method],
      set: { updatedAt: new Date() },
    })
    .returning();

  logger.info('composition.photo_read', { sessionId, sides: photos.length });
  return c.json(toEstimateDto(row!), 201);
});

/**
 * Body fat estimates across an athlete's sessions, newest first.
 *
 * Each entry is dated by its *session*, not by when the estimate was computed.
 * A formula re-run in September on June's measurements describes June, and
 * plotting it at the September end of a chart would misplace it entirely — the
 * estimate is a property of the session, not of the moment it was calculated.
 *
 * `method` narrows to one equation. Without it every method comes back, which
 * is right for a table and wrong for a line: two methods plotted as one series
 * would read as a body that jumped several points and back.
 */
compositionRoutes.get('/body-fat/history', async (c) => {
  const athleteId = c.get('athleteId');

  const requested = Number(c.req.query('limit') ?? 24);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 200) : 24;

  const method = c.req.query('method');
  if (method !== undefined && !['navy', 'ymca', 'ai'].includes(method)) {
    throw badRequest(`Unknown method: ${method}.`, { method });
  }

  const { db } = await getDb();

  const rows = await db
    .select({
      sessionId: bodyCompositionSessions.id,
      capturedAt: bodyCompositionSessions.capturedAt,
      localDate: bodyCompositionSessions.localDate,
      method: bodyFatEstimates.method,
      valueLow: bodyFatEstimates.valueLow,
      valueHigh: bodyFatEstimates.valueHigh,
      confidenceLabel: bodyFatEstimates.confidenceLabel,
    })
    .from(bodyFatEstimates)
    .innerJoin(bodyCompositionSessions, eq(bodyFatEstimates.sessionId, bodyCompositionSessions.id))
    .where(
      method === undefined
        ? eq(bodyCompositionSessions.athleteId, athleteId)
        : and(
            eq(bodyCompositionSessions.athleteId, athleteId),
            eq(bodyFatEstimates.method, method),
          ),
    )
    .orderBy(desc(bodyCompositionSessions.capturedAt))
    .limit(limit);

  const body: BodyFatHistoryDto = {
    entries: rows.map((row) => ({
      sessionId: row.sessionId,
      capturedAt: row.capturedAt.toISOString(),
      localDate: row.localDate,
      method: row.method as BodyFatHistoryDto['entries'][number]['method'],
      valueLow: row.valueLow,
      valueHigh: row.valueHigh,
      confidence: row.confidenceLabel as BodyFatHistoryDto['entries'][number]['confidence'],
    })),
    // Only the methods actually present, so a client offers real choices
    // rather than a filter that returns nothing.
    methods: [...new Set(rows.map((row) => row.method))].sort() as BodyFatHistoryDto['methods'],
  };

  return c.json(body);
});

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Sessions an athlete can pick between, newest first.
 *
 * Counts rather than contents. A picker showing ten sessions does not need
 * forty photo records and sixty measurements to render ten rows, and asking for
 * them would make opening the picker the most expensive thing on the screen.
 *
 * The counts come from three separate grouped queries rather than one join.
 * Joining two one-to-many tables in a single statement multiplies their rows
 * against each other — a session with four photos and six measurements would
 * report twenty-four of each — and that is the kind of wrong number nothing
 * downstream can detect.
 */
compositionRoutes.get('/sessions/options', async (c) => {
  const athleteId = c.get('athleteId');

  const requested = Number(c.req.query('limit') ?? 50);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 200) : 50;

  const { db } = await getDb();

  const sessions = await db
    .select()
    .from(bodyCompositionSessions)
    .where(eq(bodyCompositionSessions.athleteId, athleteId))
    .orderBy(desc(bodyCompositionSessions.capturedAt))
    .limit(limit);

  if (sessions.length === 0) return c.json({ sessions: [] });

  const ids = sessions.map((session) => session.id);

  const [photoCounts, measurementCounts, estimateCounts] = await Promise.all([
    db
      .select({ sessionId: compositionPhotos.sessionId, count: count() })
      .from(compositionPhotos)
      .where(inArray(compositionPhotos.sessionId, ids))
      .groupBy(compositionPhotos.sessionId),
    db
      .select({ sessionId: compositionMeasurements.sessionId, count: count() })
      .from(compositionMeasurements)
      .where(inArray(compositionMeasurements.sessionId, ids))
      .groupBy(compositionMeasurements.sessionId),
    db
      .select({ sessionId: bodyFatEstimates.sessionId, count: count() })
      .from(bodyFatEstimates)
      .where(inArray(bodyFatEstimates.sessionId, ids))
      .groupBy(bodyFatEstimates.sessionId),
  ]);

  const tally = (rows: { sessionId: string; count: number }[]): Map<string, number> =>
    new Map(rows.map((row) => [row.sessionId, row.count]));

  const photos = tally(photoCounts);
  const measurements = tally(measurementCounts);
  const estimates = tally(estimateCounts);

  const options: ComparisonOptionDto[] = sessions.map((session) => {
    const photoCount = photos.get(session.id) ?? 0;
    const measurementCount = measurements.get(session.id) ?? 0;

    return {
      id: session.id,
      capturedAt: session.capturedAt.toISOString(),
      localDate: session.localDate,
      ...(session.note ? { note: session.note } : {}),
      photoCount,
      measurementCount,
      estimateCount: estimates.get(session.id) ?? 0,
      // An empty session offered as a choice lets an athlete pick a pair that
      // can produce no comparison, and then wonder why the screen is blank.
      comparable: photoCount > 0 || measurementCount > 0,
    };
  });

  return c.json({ sessions: options });
});

/**
 * Serve one photo's bytes.
 *
 * The only way a photo ever leaves this server to a client. Storage keys are
 * never handed out, so an athlete's app asks for a photo by session and photo
 * id and we check both belong to them before opening anything — a key in a URL
 * would be a capability that outlives the session that granted it.
 *
 * Cached privately rather than not at all. Four photos re-downloaded on every
 * render of a comparison screen is a real cost on a phone, and the response is
 * marked private so no shared cache between here and the device keeps a copy.
 */
compositionRoutes.get('/sessions/:sessionId/photos/:photoId', async (c) => {
  const athleteId = c.get('athleteId');
  const sessionId = c.req.param('sessionId');

  const { db } = await getDb();
  await ownedSession(db, athleteId, sessionId);

  const [photo] = await db
    .select()
    .from(compositionPhotos)
    .where(
      and(
        eq(compositionPhotos.id, c.req.param('photoId')),
        // Scoped to the session in the query: a photo id from another
        // session, even the athlete's own, is not reachable through this one.
        eq(compositionPhotos.sessionId, sessionId),
      ),
    )
    .limit(1);

  if (!photo) throw notFound('Photo');

  const file = await photoStorage().read(photo.storageKey);
  // A row without bytes is a 404 for the caller, and a real problem for us.
  if (!file) {
    logger.error('composition.photo_missing', { sessionId, photoId: photo.id });
    throw notFound('Photo');
  }

  c.header('content-type', file.contentType);
  c.header('content-length', String(file.bytes.byteLength));
  c.header('cache-control', 'private, max-age=3600, must-revalidate');
  // Nothing about this response should be interpreted as a document.
  c.header('x-content-type-options', 'nosniff');
  c.header(
    'content-disposition',
    `inline; filename="${photo.side}.${photo.contentType.split('/')[1] ?? 'jpg'}"`,
  );

  return c.body(file.bytes as unknown as ArrayBuffer);
});

/**
 * Two sessions' photos, paired by side.
 *
 * All four sides come back whether or not both photos exist. A response that
 * quietly dropped the sides it could not pair would make a half-photographed
 * session look complete, and the value of a four-side set is precisely that the
 * same view is in both sessions to put against each other.
 */
compositionRoutes.get('/compare/photos', async (c) => {
  const athleteId = c.get('athleteId');

  const parsed = compareSessionsQuerySchema.safeParse({
    earlierId: c.req.query('earlierId'),
    laterId: c.req.query('laterId'),
    ...(c.req.query('days') !== undefined ? { days: c.req.query('days') } : {}),
  });
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Those sessions were not valid.');
  }

  const { db } = await getDb();
  const pair = await resolveComparisonPair(db, athleteId, parsed.data);

  const photos = await db
    .select()
    .from(compositionPhotos)
    .where(inArray(compositionPhotos.sessionId, [pair.earlier.id, pair.later.id]));

  const find = (sessionId: string, side: string): PhotoRow | undefined =>
    photos.find((photo) => photo.sessionId === sessionId && photo.side === side);

  const pairs: PhotoPairDto[] = PHOTO_SIDES.map((side) => {
    const earlier = find(pair.earlier.id, side);
    const later = find(pair.later.id, side);

    return {
      side,
      ...(earlier ? { earlier: toPhotoDto(earlier) } : {}),
      ...(later ? { later: toPhotoDto(later) } : {}),
      comparable: earlier !== undefined && later !== undefined,
    };
  });

  return c.json({
    earlier: {
      id: pair.earlier.id,
      capturedAt: pair.earlier.capturedAt.toISOString(),
      localDate: pair.earlier.localDate,
    },
    later: {
      id: pair.later.id,
      capturedAt: pair.later.capturedAt.toISOString(),
      localDate: pair.later.localDate,
    },
    photos: pairs,
  });
});

/**
 * Work out which two sessions a request means.
 *
 * Two ids, or a window that resolves to its widest pair — "the last three
 * months" means the span of that window, not the two most recent sessions that
 * happen to fall inside it. Fewer than two sessions is a 400 rather than an
 * empty comparison, because one session is not a comparison and silently
 * widening the range would answer a question nobody asked.
 */
async function resolveComparisonPair(
  db: Awaited<ReturnType<typeof getDb>>['db'],
  athleteId: string,
  query: { earlierId?: string; laterId?: string; days?: number },
): Promise<{ earlier: SessionRow; later: SessionRow }> {
  if (query.earlierId && query.laterId) {
    const earlier = await ownedSession(db, athleteId, query.earlierId);
    const later = await ownedSession(db, athleteId, query.laterId);

    // Ordered here, so "earlier" and "later" mean what they say downstream
    // regardless of which one the athlete tapped first.
    return earlier.capturedAt <= later.capturedAt
      ? { earlier, later }
      : { earlier: later, later: earlier };
  }

  const cutoff =
    query.days === undefined ? undefined : new Date(Date.now() - query.days * 86_400_000);

  const sessions = await db
    .select()
    .from(bodyCompositionSessions)
    .where(
      cutoff === undefined
        ? eq(bodyCompositionSessions.athleteId, athleteId)
        : and(
            eq(bodyCompositionSessions.athleteId, athleteId),
            gte(bodyCompositionSessions.capturedAt, cutoff),
          ),
    )
    .orderBy(desc(bodyCompositionSessions.capturedAt));

  if (sessions.length < 2) {
    throw badRequest(
      'A comparison needs two sessions in the range you chose. Try a longer range, or pick two sessions directly.',
      { found: sessions.length },
    );
  }

  return { earlier: sessions[sessions.length - 1]!, later: sessions[0]! };
}

/**
 * One metric over time, for the trend chart.
 *
 * One metric per request, and the unit travels with it. Centimetres, kilograms
 * and a percentage never share an axis — the alignment between two scales is
 * arbitrary, so a chart drawing two of them together would invent a correlation
 * that is not in the data. The metric selector is what keeps the chart honest,
 * not a convenience.
 *
 * `metric` is `circumference:<pointCode>`, `weight`, or `bodyFat:<method>`.
 */
compositionRoutes.get('/trend', async (c) => {
  const athleteId = c.get('athleteId');
  const metric = c.req.query('metric') ?? 'circumference:waist';

  const requestedDays = Number(c.req.query('days') ?? Number.NaN);
  const days =
    Number.isFinite(requestedDays) && requestedDays > 0 ? Math.trunc(requestedDays) : undefined;
  const cutoff = days === undefined ? undefined : new Date(Date.now() - days * 86_400_000);

  const { db } = await getDb();

  const withinWindow = (column: typeof bodyCompositionSessions.capturedAt) =>
    cutoff === undefined ? undefined : gte(column, cutoff);

  if (metric === 'weight') {
    // Weight already has a home: the provider-sourced body measurements the
    // rest of the app reads. A second store for it would drift.
    const rows = await db
      .select()
      .from(bodyMeasurements)
      .where(
        cutoff === undefined
          ? and(eq(bodyMeasurements.athleteId, athleteId), eq(bodyMeasurements.metric, 'weight_kg'))
          : and(
              eq(bodyMeasurements.athleteId, athleteId),
              eq(bodyMeasurements.metric, 'weight_kg'),
              gte(bodyMeasurements.measuredAt, cutoff),
            ),
      )
      .orderBy(asc(bodyMeasurements.measuredAt));

    const body: TrendSeriesDto = {
      metric: 'weight',
      label: 'Weight',
      unit: 'kg',
      points: rows.map((row) => ({
        capturedAt: row.measuredAt.toISOString(),
        localDate: row.measuredAt.toISOString().slice(0, 10),
        value: row.normalizedValue,
      })),
    };
    return c.json(body);
  }

  if (metric.startsWith('bodyFat')) {
    const method = metric.split(':')[1] ?? 'navy';
    if (!['navy', 'ymca', 'ai'].includes(method)) {
      throw badRequest(`Unknown body fat method: ${method}.`, { method });
    }

    const rows = await db
      .select({
        capturedAt: bodyCompositionSessions.capturedAt,
        localDate: bodyCompositionSessions.localDate,
        low: bodyFatEstimates.valueLow,
        high: bodyFatEstimates.valueHigh,
      })
      .from(bodyFatEstimates)
      .innerJoin(
        bodyCompositionSessions,
        eq(bodyFatEstimates.sessionId, bodyCompositionSessions.id),
      )
      .where(
        and(
          eq(bodyCompositionSessions.athleteId, athleteId),
          eq(bodyFatEstimates.method, method),
          ...(withinWindow(bodyCompositionSessions.capturedAt)
            ? [withinWindow(bodyCompositionSessions.capturedAt)!]
            : []),
        ),
      )
      .orderBy(asc(bodyCompositionSessions.capturedAt));

    const body: TrendSeriesDto = {
      metric,
      label: 'Body fat estimate',
      unit: '%',
      // A band, not a line: the estimate has no single value, and a single
      // trace would imply a precision it does not have.
      band: rows.map((row) => ({
        capturedAt: row.capturedAt.toISOString(),
        localDate: row.localDate,
        low: row.low,
        high: row.high,
      })),
    };
    return c.json(body);
  }

  const code = metric.startsWith('circumference:')
    ? metric.slice('circumference:'.length)
    : undefined;
  if (!code) throw badRequest(`Unknown metric: ${metric}.`, { metric });

  const point = await pointByCode(db, code);

  const rows = await db
    .select({
      capturedAt: bodyCompositionSessions.capturedAt,
      localDate: bodyCompositionSessions.localDate,
      valueCm: compositionMeasurements.valueCm,
    })
    .from(compositionMeasurements)
    .innerJoin(
      bodyCompositionSessions,
      eq(compositionMeasurements.sessionId, bodyCompositionSessions.id),
    )
    .where(
      and(
        eq(bodyCompositionSessions.athleteId, athleteId),
        eq(compositionMeasurements.pointId, point.id),
        ...(withinWindow(bodyCompositionSessions.capturedAt)
          ? [withinWindow(bodyCompositionSessions.capturedAt)!]
          : []),
      ),
    )
    .orderBy(asc(bodyCompositionSessions.capturedAt));

  // Deltas come from core, the same function the app uses, so a change read
  // here and one read on the phone cannot disagree.
  const withChange = withChangesCore(
    rows.map((row) => ({
      capturedAt: row.capturedAt.toISOString(),
      localDate: row.localDate,
      valueCm: row.valueCm,
    })),
  );

  const body: TrendSeriesDto = {
    metric,
    // The point's own label, not its code: the chart title is read by a
    // person, and "left_arm" is not how anyone says it.
    label: point.label,
    unit: 'cm',
    // Oldest first for plotting; `withChanges` returns newest first.
    points: [...withChange].reverse().map((entry) => ({
      capturedAt: entry.capturedAt,
      localDate: entry.localDate,
      value: entry.valueCm,
      ...(entry.changeCm !== undefined ? { changeCm: entry.changeCm } : {}),
    })),
  };

  return c.json(body);
});

/**
 * Everything that changed between two sessions.
 *
 * The rule this endpoint exists to get right: a point measured in one session
 * and not the other has **no** change. Not zero. An athlete who skipped their
 * thigh in June would read a zero in September as three months of nothing
 * happening, and no amount of UI can undo a number the server asserted.
 *
 * The second rule: a move smaller than a tape can repeat is reported as steady,
 * which is a finding, rather than as a direction, which would be a fiction. The
 * threshold travels in the response so the word is not a black box.
 *
 * Nothing here judges a direction. A waist coming down and an arm coming down
 * are not the same news, and the server cannot know which the athlete trained
 * for — so the summary counts and the rows point, and neither approves.
 */
compositionRoutes.get('/compare', async (c) => {
  const athleteId = c.get('athleteId');

  const parsed = compareSessionsQuerySchema.safeParse({
    earlierId: c.req.query('earlierId'),
    laterId: c.req.query('laterId'),
    ...(c.req.query('days') !== undefined ? { days: c.req.query('days') } : {}),
  });
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Those sessions were not valid.');
  }

  const { db } = await getDb();
  const pair = await resolveComparisonPair(db, athleteId, parsed.data);

  const points = await db
    .select()
    .from(circumferencePoints)
    .orderBy(asc(circumferencePoints.sortOrder));

  const measurements = await db
    .select({
      sessionId: compositionMeasurements.sessionId,
      pointId: compositionMeasurements.pointId,
      valueCm: compositionMeasurements.valueCm,
    })
    .from(compositionMeasurements)
    .where(inArray(compositionMeasurements.sessionId, [pair.earlier.id, pair.later.id]));

  const valueFor = (sessionId: string, pointId: string): number | undefined =>
    measurements.find((row) => row.sessionId === sessionId && row.pointId === pointId)?.valueCm;

  let movedCount = 0;
  let steadyCount = 0;
  let onlyOneSessionCount = 0;
  let total = 0;
  let comparable = 0;

  const rows: SessionComparisonDto['rows'] = points.map((point) => {
    const fromCm = valueFor(pair.earlier.id, point.id);
    const toCm = valueFor(pair.later.id, point.id);

    if (fromCm === undefined || toCm === undefined) {
      if (fromCm !== undefined || toCm !== undefined) onlyOneSessionCount += 1;
      return {
        pointCode: point.code,
        pointLabel: point.label,
        ...(fromCm !== undefined ? { fromCm } : {}),
        ...(toCm !== undefined ? { toCm } : {}),
      };
    }

    const changeCm = toCm - fromCm;
    const direction = changeDirection(changeCm);

    if (direction === 'steady') steadyCount += 1;
    else movedCount += 1;

    comparable += 1;
    total += changeCm;

    return { pointCode: point.code, pointLabel: point.label, fromCm, toCm, changeCm, direction };
  });

  const photoRows = await db
    .select()
    .from(compositionPhotos)
    .where(inArray(compositionPhotos.sessionId, [pair.earlier.id, pair.later.id]));

  const photos: PhotoPairDto[] = PHOTO_SIDES.map((side) => {
    const earlier = photoRows.find((p) => p.sessionId === pair.earlier.id && p.side === side);
    const later = photoRows.find((p) => p.sessionId === pair.later.id && p.side === side);

    return {
      side,
      ...(earlier ? { earlier: toPhotoDto(earlier) } : {}),
      ...(later ? { later: toPhotoDto(later) } : {}),
      comparable: earlier !== undefined && later !== undefined,
    };
  });

  const daysApart = Math.floor(
    Math.abs(pair.later.capturedAt.getTime() - pair.earlier.capturedAt.getTime()) / 86_400_000,
  );

  const body: SessionComparisonDto = {
    earlier: {
      id: pair.earlier.id,
      capturedAt: pair.earlier.capturedAt.toISOString(),
      localDate: pair.earlier.localDate,
    },
    later: {
      id: pair.later.id,
      capturedAt: pair.later.capturedAt.toISOString(),
      localDate: pair.later.localDate,
    },
    daysApart,
    rows,
    photos,
    summary: {
      movedCount,
      steadyCount,
      onlyOneSessionCount,
      // Absent when nothing is comparable: zero would suggest it found nothing
      // rather than that it could not look.
      ...(comparable > 0 ? { totalChangeCm: Number(total.toFixed(2)) } : {}),
      thresholdCm: TAPE_REPEATABILITY_CM,
      headline: comparisonHeadline(daysApart, movedCount, steadyCount),
    },
  };

  return c.json(body);
});

/**
 * One sentence about the comparison.
 *
 * Counts, not adjectives. "Two points moved and one held steady" is something
 * the athlete can check against the rows beneath it; "good progress" is a
 * verdict this server has no standing to give.
 */
function comparisonHeadline(daysApart: number, moved: number, steady: number): string {
  const span = daysApart === 0 ? 'Between these two sessions' : `Over ${daysApart} days`;

  if (moved === 0 && steady === 0) {
    return `${span}, no measure point was recorded in both sessions, so there is nothing to compare.`;
  }

  const parts: string[] = [];
  if (moved > 0) parts.push(`${moved} ${moved === 1 ? 'point' : 'points'} moved`);
  if (steady > 0) parts.push(`${steady} held steady`);

  return `${span}, ${parts.join(' and ')}.`;
}
