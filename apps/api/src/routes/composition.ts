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
import { eq } from 'drizzle-orm';

import {
  PHOTO_SIDES,
  createCompositionSessionSchema,
  type CompositionSessionDto,
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

    const body: CompositionSessionDto = {
      id: sessionId,
      capturedAt: capturedAt.toISOString(),
      localDate,
      ...(parsed.data.note ? { note: parsed.data.note } : {}),
      photos: photos.map((photo) => ({
        id: photo.id,
        side: photo.side as CompositionSessionDto['photos'][number]['side'],
        contentType: photo.contentType,
        byteSize: photo.byteSize,
        capturedAt: photo.capturedAt.toISOString(),
        url: photoUrl(sessionId, photo.id),
      })),
    };

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
