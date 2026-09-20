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
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import {
  PHOTO_SIDES,
  createCompositionSessionSchema,
  recordMeasurementsSchema,
  type MetricHistoryDto,
  type CompositionMeasurementDto,
  type CompositionPhotoDto,
  type CompositionSessionDto,
  type LengthUnitDto,
  type PhotoSideDto,
} from '@running/contracts';
import { toCanonicalLength, withChanges, type LengthUnit } from '@running/core';
import { toLocalDate } from '@running/core';

import { getDb } from '../db/client.js';
import {
  athleteProfiles,
  bodyCompositionSessions,
  circumferencePoints,
  compositionMeasurements,
  compositionPhotos,
} from '../db/schema.js';
import { badRequest, notFound } from '../errors.js';
import { logger } from '../observability/logger.js';
import {
  photoStorage,
  validatePhotoUpload,
  type PhotoSide,
  type StoredPhoto,
} from '../services/photo-storage.js';
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

  const parsed = recordMeasurementsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw badRequest(
      parsed.error.issues[0]?.message ?? 'Some of those measurements were not valid.',
      { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
    );
  }

  const { db } = await getDb();
  const session = await ownedSession(db, athleteId, sessionId);

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
