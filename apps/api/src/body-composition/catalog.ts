/**
 * Circumference point catalog.
 *
 * `circumference_points` is reference data: every deployment needs the same
 * eight rows before a single measurement can be stored, and the guide text is
 * copy the product owns. The rows are therefore upserted from the catalog in
 * `@running/core` every time migrations run, which makes a fresh database, a
 * test database and a long-lived production database converge on the same
 * content without a hand-written data migration.
 */

import { CIRCUMFERENCE_POINT_CATALOG } from '@running/core';

import type { Database } from '../db/client.js';
import { circumferencePoints } from '../db/schema.js';

/** Insert or refresh every catalog point. Idempotent; keyed on `code`. */
export async function ensureCircumferencePoints(db: Database): Promise<void> {
  for (const point of CIRCUMFERENCE_POINT_CATALOG) {
    await db
      .insert(circumferencePoints)
      .values({
        code: point.code,
        label: point.label,
        guideText: point.guideText,
        sortOrder: point.sortOrder,
      })
      .onConflictDoUpdate({
        target: circumferencePoints.code,
        set: {
          label: point.label,
          guideText: point.guideText,
          sortOrder: point.sortOrder,
          updatedAt: new Date(),
        },
      });
  }
}
