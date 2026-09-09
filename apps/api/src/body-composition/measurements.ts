/**
 * Tape measurements for a session.
 *
 * The athlete picks a point from the catalog, reads the guide, and enters a
 * value in the unit they think in. The row keeps that value and unit exactly
 * as entered and adds the canonical centimetre form every calculation reads,
 * so a unit slip is always visible after the fact. One value per point per
 * session: entering a point again corrects it rather than adding a second.
 */

import { and, eq } from 'drizzle-orm';

import type { BodyCompositionSessionDto, SaveMeasurementsDto } from '@running/contracts';
import { circumferencePoint, isCircumferencePointCode, toCentimetres } from '@running/core';

import type { Database } from '../db/client.js';
import { circumferencePoints, compositionMeasurements } from '../db/schema.js';
import { badRequest, notFound } from '../errors.js';
import { loadSession, requireOwnedSession } from './sessions.js';

/**
 * Bounds on a circumference after conversion to centimetres. Wide enough for
 * any adult; tight enough to catch a value typed in the wrong field or the
 * wrong unit.
 */
const MIN_CM = 10;
const MAX_CM = 300;

async function catalogIdsByCode(db: Database): Promise<Map<string, string>> {
  const rows = await db.select().from(circumferencePoints);
  return new Map(rows.map((r) => [r.code, r.id]));
}

/** Save one or more readings; returns the session with estimates recomputed. */
export async function saveMeasurements(
  db: Database,
  athleteId: string,
  sessionId: string,
  input: SaveMeasurementsDto,
): Promise<BodyCompositionSessionDto> {
  const session = await requireOwnedSession(db, athleteId, sessionId);
  const capturedAt = input.capturedAt ? new Date(input.capturedAt) : session.capturedAt;

  const seen = new Set<string>();
  for (const reading of input.measurements) {
    if (!isCircumferencePointCode(reading.pointCode)) {
      throw badRequest(`Unknown measurement point: ${reading.pointCode}.`, {
        pointCode: reading.pointCode,
      });
    }
    if (seen.has(reading.pointCode)) {
      throw badRequest(`${circumferencePoint(reading.pointCode).label} appears more than once.`);
    }
    seen.add(reading.pointCode);

    const valueCm = toCentimetres(reading.value, reading.unit);
    if (valueCm < MIN_CM || valueCm > MAX_CM) {
      throw badRequest(
        `${circumferencePoint(reading.pointCode).label} of ${reading.value} ${reading.unit} is outside the range a tape can read. Check the value and the unit.`,
        { pointCode: reading.pointCode },
      );
    }
  }

  const idsByCode = await catalogIdsByCode(db);
  for (const reading of input.measurements) {
    const pointId = idsByCode.get(reading.pointCode);
    if (!pointId) throw notFound('Measurement point');
    const values = {
      value: reading.value,
      unit: reading.unit,
      valueCm: toCentimetres(reading.value, reading.unit),
      capturedAt,
    };
    await db
      .insert(compositionMeasurements)
      .values({ sessionId: session.id, athleteId, pointId, ...values })
      .onConflictDoUpdate({
        target: [compositionMeasurements.sessionId, compositionMeasurements.pointId],
        set: { ...values, updatedAt: new Date() },
      });
  }

  const updated = await loadSession(db, athleteId, sessionId);
  if (!updated) throw notFound('Session');
  return updated;
}

/**
 * Remove one point's reading from a session. Idempotent: removing a point
 * that has no reading is not an error, and the session comes back either way.
 */
export async function deleteMeasurement(
  db: Database,
  athleteId: string,
  sessionId: string,
  pointCode: string,
): Promise<BodyCompositionSessionDto> {
  const session = await requireOwnedSession(db, athleteId, sessionId);
  if (!isCircumferencePointCode(pointCode)) {
    throw badRequest(`Unknown measurement point: ${pointCode}.`, { pointCode });
  }

  const pointId = (await catalogIdsByCode(db)).get(pointCode);
  if (pointId) {
    await db
      .delete(compositionMeasurements)
      .where(
        and(
          eq(compositionMeasurements.sessionId, session.id),
          eq(compositionMeasurements.pointId, pointId),
        ),
      );
  }

  const updated = await loadSession(db, athleteId, sessionId);
  if (!updated) throw notFound('Session');
  return updated;
}
