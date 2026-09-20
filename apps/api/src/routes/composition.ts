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
import { desc, eq, inArray } from 'drizzle-orm';

import {
  PHOTO_SIDES,
  createCompositionSessionSchema,
  type CompositionPhotoDto,
  type CompositionSessionDto,
  type PhotoSideDto,
} from '@running/contracts';
import { toLocalDate } from '@running/core';

import { getDb } from '../db/client.js';
import { athleteProfiles, bodyCompositionSessions, compositionPhotos } from '../db/schema.js';
import { badRequest } from '../errors.js';
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
function toSessionDto(session: SessionRow, photos: readonly PhotoRow[]): CompositionSessionDto {
  return {
    id: session.id,
    capturedAt: session.capturedAt.toISOString(),
    localDate: session.localDate,
    ...(session.note ? { note: session.note } : {}),
    photos: [...photos]
      .sort((a, b) => (SIDE_ORDER.get(a.side) ?? 99) - (SIDE_ORDER.get(b.side) ?? 99))
      .map(toPhotoDto),
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

  const bySession = new Map<string, PhotoRow[]>();
  for (const photo of photos) {
    const list = bySession.get(photo.sessionId) ?? [];
    list.push(photo);
    bySession.set(photo.sessionId, list);
  }

  return c.json({
    sessions: sessions.map((session) => toSessionDto(session, bySession.get(session.id) ?? [])),
  });
});
