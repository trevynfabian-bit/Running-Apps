/**
 * Body composition routes: the summary the module opens on, sessions and
 * their photos. Measurements, history and comparison follow in later tasks.
 *
 * Mounted under `/api/body-composition`, so the app-wide auth boundary in
 * `app.ts` covers every route here; each handler reads the athlete from the
 * verified token and never from the request, and a session that belongs to
 * someone else is indistinguishable from one that does not exist.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { API_ERROR_CODES, createBodyCompositionSessionSchema } from '@running/contracts';
import { isPhotoSide, type PhotoSide } from '@running/core';

import { getDb } from '../db/client.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import type { AuthVariables } from '../security/auth.js';
import { MAX_PHOTO_BYTES, readPhoto, savePhoto } from '../body-composition/photos.js';
import { buildSummary, createSession, loadSession } from '../body-composition/sessions.js';

export const bodyCompositionRoutes = new Hono<{ Variables: AuthVariables }>();

/**
 * The module's front door: the tape-point catalog and default unit, the
 * latest session in full, and the most recent sessions for the history list.
 */
bodyCompositionRoutes.get('/summary', async (c) => {
  const { db } = await getDb();
  return c.json(await buildSummary(db, c.get('athleteId')));
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Start a session. An empty body is fine: it means "now". */
bodyCompositionRoutes.post('/sessions', async (c) => {
  const raw = await c.req.text();
  const input = createBodyCompositionSessionSchema.parse(raw.trim() ? JSON.parse(raw) : {});
  const { db } = await getDb();
  const session = await createSession(db, c.get('athleteId'), input);
  return c.json(session, 201);
});

bodyCompositionRoutes.get('/sessions/:id', async (c) => {
  const { db } = await getDb();
  const session = await loadSession(db, c.get('athleteId'), c.req.param('id'));
  if (!session) throw notFound('Session');
  return c.json(session);
});

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

function sideParam(value: string): PhotoSide {
  if (!isPhotoSide(value)) throw badRequest('Side must be one of front, back, left, right.');
  return value;
}

const photoTooLarge = new ApiError(
  413,
  API_ERROR_CODES.VALIDATION_FAILED,
  'That photo is too large. Keep each photo under 10 MB.',
);

/**
 * Save or replace one side's photo. Accepts either a multipart form with a
 * `photo` file field (and optional `capturedAt`), or the raw image bytes with
 * an image content type. Uploading a side again is a retake.
 */
bodyCompositionRoutes.put(
  '/sessions/:id/photos/:side',
  bodyLimit({
    maxSize: MAX_PHOTO_BYTES,
    onError: (c) => c.json(photoTooLarge.toBody(), 413),
  }),
  async (c) => {
    const side = sideParam(c.req.param('side'));
    const contentType = c.req.header('content-type') ?? '';

    let bytes: Uint8Array;
    let capturedAt: string | undefined;
    if (contentType.startsWith('multipart/form-data')) {
      const form = await c.req.parseBody();
      const file = form['photo'];
      if (!(file instanceof File)) throw badRequest('Send the photo as a "photo" file field.');
      bytes = new Uint8Array(await file.arrayBuffer());
      capturedAt = typeof form['capturedAt'] === 'string' ? form['capturedAt'] : undefined;
    } else {
      bytes = new Uint8Array(await c.req.arrayBuffer());
      capturedAt = c.req.query('capturedAt');
    }

    const capturedAtDate = capturedAt ? new Date(capturedAt) : undefined;
    if (capturedAtDate && Number.isNaN(capturedAtDate.getTime())) {
      throw badRequest('capturedAt must be an ISO-8601 date-time.');
    }

    const { db } = await getDb();
    const photo = await savePhoto(db, {
      athleteId: c.get('athleteId'),
      sessionId: c.req.param('id'),
      side,
      bytes,
      capturedAt: capturedAtDate,
    });
    return c.json(photo);
  },
);

/** The bytes of one side's photo, for the owner only. Never cached by proxies. */
bodyCompositionRoutes.get('/sessions/:id/photos/:side', async (c) => {
  const side = sideParam(c.req.param('side'));
  const { db } = await getDb();
  const photo = await readPhoto(db, c.get('athleteId'), c.req.param('id'), side);
  if (!photo) throw notFound('Photo');
  // Copy into a plain ArrayBuffer-backed view: the store may hand back a
  // view over a shared buffer, which the response body type does not accept.
  const body = new Uint8Array(photo.bytes);
  return c.body(body, 200, {
    'content-type': photo.contentType,
    'content-length': String(body.byteLength),
    'cache-control': 'private, no-store',
  });
});
