/**
 * Body composition routes: the summary the module opens on, and in later
 * phases sessions, photos, measurements and comparisons.
 *
 * Mounted under `/api/body-composition`, so the app-wide auth boundary in
 * `app.ts` covers every route here; each handler reads the athlete from the
 * verified token and never from the request.
 */

import { Hono } from 'hono';

import { getDb } from '../db/client.js';
import type { AuthVariables } from '../security/auth.js';
import { buildSummary } from '../body-composition/sessions.js';

export const bodyCompositionRoutes = new Hono<{ Variables: AuthVariables }>();

/**
 * The module's front door: the tape-point catalog and default unit, the
 * latest session in full, and the most recent sessions for the history list.
 */
bodyCompositionRoutes.get('/summary', async (c) => {
  const { db } = await getDb();
  return c.json(await buildSummary(db, c.get('athleteId')));
});
