/**
 * What a session actually holds.
 *
 * The history screen's job on a privacy page is not to be a pretty list — it is
 * to answer "what have I got stored, and where is it". A row that says only
 * "6 September" leaves an athlete deciding whether to delete something without
 * knowing what the something is.
 *
 * So every session is described by its contents: how many photos, how many
 * measurements, whether an estimate was derived from them, and — the part that
 * matters most on this screen — whether any of it left the device.
 */

import { hasPhotos, type BodyCompositionSession } from './composition-session';

/** Where a piece of a session lives. */
export type StorageLocation = 'device' | 'server';

export interface SessionInventory {
  sessionId: string;
  capturedAt: string;
  photoCount: number;
  measurementCount: number;
  /** True when the session holds nothing at all. */
  isEmpty: boolean;
  /**
   * Where this session's contents are.
   *
   * Photos go to the server — they have to, the reading service runs there —
   * so a session with photos is a session with something off the device.
   * Measurements are numbers that sync, but the distinction an athlete cares
   * about on a privacy screen is pictures of their body, so that is what this
   * flag tracks.
   */
  locations: readonly StorageLocation[];
}

export function inventorySession(session: BodyCompositionSession): SessionInventory {
  const photoCount = session.photos?.length ?? 0;
  const measurementCount = session.measurements.length;

  const locations: StorageLocation[] = ['device'];
  if (hasPhotos(session)) locations.push('server');

  return {
    sessionId: session.id,
    capturedAt: session.capturedAt,
    photoCount,
    measurementCount,
    isEmpty: photoCount === 0 && measurementCount === 0,
    locations,
  };
}

/** Sessions newest first, each described by what it holds. */
export function inventory(
  sessions: readonly BodyCompositionSession[],
): readonly SessionInventory[] {
  return [...sessions]
    .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))
    .map(inventorySession);
}

export interface InventoryTotals {
  sessionCount: number;
  photoCount: number;
  measurementCount: number;
  /** Sessions with something stored on the server. */
  sessionsOnServer: number;
}

/**
 * Totals across every session.
 *
 * Shown at the top of the privacy screen because "you have 4 sessions and 16
 * photos on our servers" is a concrete, checkable statement, and "we take your
 * privacy seriously" is not.
 */
export function inventoryTotals(entries: readonly SessionInventory[]): InventoryTotals {
  return {
    sessionCount: entries.length,
    photoCount: entries.reduce((sum, entry) => sum + entry.photoCount, 0),
    measurementCount: entries.reduce((sum, entry) => sum + entry.measurementCount, 0),
    sessionsOnServer: entries.filter((entry) => entry.locations.includes('server')).length,
  };
}

/** A plain description of one session's contents, for a list row. */
export function describeContents(entry: SessionInventory): string {
  if (entry.isEmpty) return 'Nothing recorded';

  const parts: string[] = [];
  if (entry.photoCount > 0) {
    parts.push(`${entry.photoCount} ${entry.photoCount === 1 ? 'photo' : 'photos'}`);
  }
  if (entry.measurementCount > 0) {
    parts.push(
      `${entry.measurementCount} ${entry.measurementCount === 1 ? 'measurement' : 'measurements'}`,
    );
  }

  return parts.join(' · ');
}
