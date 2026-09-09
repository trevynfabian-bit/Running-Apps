/**
 * Session photos: one per side, replaceable.
 *
 * Retaking a side is the normal case, not an edge case: the athlete looks at
 * the four sides together and redoes the blurry one. So a photo is saved with
 * an upsert on (session, side), and the old file goes only after the new one
 * is safely written.
 */

import { and, eq } from 'drizzle-orm';

import type { CompositionPhotoDto } from '@running/contracts';
import type { PhotoSide } from '@running/core';

import type { Database } from '../db/client.js';
import { bodyCompositionSessions, compositionPhotos } from '../db/schema.js';
import { badRequest, notFound } from '../errors.js';
import { getPhotoStore, inspectImage } from './photo-store.js';
import { toPhotoDto } from './sessions.js';

/** Upper bound on one photo. Phone cameras produce 2 to 6 MB; this leaves room. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export const NOT_A_PHOTO_MESSAGE =
  'That file is not a photo we can store. Use a JPEG, PNG, WebP or HEIC image.';

async function ownedSession(
  db: Database,
  athleteId: string,
  sessionId: string,
): Promise<typeof bodyCompositionSessions.$inferSelect> {
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

export async function savePhoto(
  db: Database,
  input: {
    athleteId: string;
    sessionId: string;
    side: PhotoSide;
    bytes: Uint8Array;
    /** When the photo was taken; defaults to the session's capture time. */
    capturedAt?: Date;
  },
): Promise<CompositionPhotoDto> {
  const session = await ownedSession(db, input.athleteId, input.sessionId);

  if (input.bytes.length === 0) throw badRequest('The photo was empty.');
  const image = inspectImage(input.bytes);
  if (!image) throw badRequest(NOT_A_PHOTO_MESSAGE);

  const storageKey = `athletes/${input.athleteId}/sessions/${session.id}/${input.side}.${image.extension}`;
  const capturedAt = input.capturedAt ?? session.capturedAt;

  const [existing] = await db
    .select()
    .from(compositionPhotos)
    .where(and(eq(compositionPhotos.sessionId, session.id), eq(compositionPhotos.side, input.side)))
    .limit(1);

  const store = getPhotoStore();
  await store.put(storageKey, input.bytes);

  const values = {
    storageKey,
    contentType: image.contentType,
    byteSize: input.bytes.length,
    widthPx: image.widthPx ?? null,
    heightPx: image.heightPx ?? null,
    capturedAt,
  };
  const [row] = await db
    .insert(compositionPhotos)
    .values({ sessionId: session.id, athleteId: input.athleteId, side: input.side, ...values })
    .onConflictDoUpdate({
      target: [compositionPhotos.sessionId, compositionPhotos.side],
      set: values,
    })
    .returning();

  // A retake in a different format leaves the previous file behind; the new
  // one is already durable, so removing the old one now is safe.
  if (existing && existing.storageKey !== storageKey) await store.remove(existing.storageKey);

  return toPhotoDto(row!)!;
}

export async function readPhoto(
  db: Database,
  athleteId: string,
  sessionId: string,
  side: PhotoSide,
): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
  const [row] = await db
    .select()
    .from(compositionPhotos)
    .where(
      and(
        eq(compositionPhotos.sessionId, sessionId),
        eq(compositionPhotos.athleteId, athleteId),
        eq(compositionPhotos.side, side),
      ),
    )
    .limit(1);
  if (!row) return undefined;

  const bytes = await getPhotoStore().get(row.storageKey);
  if (!bytes) return undefined;
  return { bytes, contentType: row.contentType ?? 'application/octet-stream' };
}
