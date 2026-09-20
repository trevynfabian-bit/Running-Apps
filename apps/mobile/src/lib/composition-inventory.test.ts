/**
 * A privacy screen that cannot say what is stored is decoration. These check
 * the counts are real and that photos are recognised as having left the device.
 */

import { describe, expect, it } from 'vitest';

import type { BodyCompositionSession } from './composition-session';
import {
  describeContents,
  inventory,
  inventorySession,
  inventoryTotals,
} from './composition-inventory';

function session(
  id: string,
  capturedAt: string,
  options: { photos?: number; measurements?: number } = {},
): BodyCompositionSession {
  const sides = ['front', 'back', 'left', 'right'] as const;

  return {
    id,
    capturedAt,
    measurements: Array.from({ length: options.measurements ?? 0 }, (_, index) => ({
      id: `${id}-m${index}`,
      pointId: `point-${index}`,
      valueCm: 80 + index,
      recordedUnit: 'cm' as const,
      capturedAt,
    })),
    ...(options.photos
      ? {
          photos: Array.from({ length: options.photos }, (_, index) => ({
            id: `${id}-p${index}`,
            side: sides[index % 4]!,
            capturedAt,
          })),
        }
      : {}),
  };
}

describe('inventorySession', () => {
  it('counts what the session holds', () => {
    const entry = inventorySession(
      session('a', '2026-09-06T07:45:00.000Z', {
        photos: 4,
        measurements: 6,
      }),
    );

    expect(entry.photoCount).toBe(4);
    expect(entry.measurementCount).toBe(6);
    expect(entry.isEmpty).toBe(false);
  });

  it('marks a session with photos as having something on the server', () => {
    // Photos have to go to the server — the reading service runs there — and
    // that is the thing an athlete cares about on a privacy screen.
    const withPhotos = inventorySession(session('a', '2026-09-06T07:45:00.000Z', { photos: 4 }));
    const numbersOnly = inventorySession(
      session('b', '2026-07-12T07:15:00.000Z', { measurements: 6 }),
    );

    expect(withPhotos.locations).toContain('server');
    expect(numbersOnly.locations).not.toContain('server');
    expect(numbersOnly.locations).toContain('device');
  });

  it('recognises an empty session', () => {
    expect(inventorySession(session('a', '2026-09-06T07:45:00.000Z')).isEmpty).toBe(true);
  });
});

describe('inventory', () => {
  it('lists sessions newest first', () => {
    const entries = inventory([
      session('june', '2026-06-14T07:30:00.000Z', { photos: 4 }),
      session('september', '2026-09-06T07:45:00.000Z', { photos: 4 }),
      session('july', '2026-07-12T07:15:00.000Z', { measurements: 6 }),
    ]);

    expect(entries.map((entry) => entry.sessionId)).toEqual(['september', 'july', 'june']);
  });
});

describe('inventoryTotals', () => {
  it('totals what is stored, and how much of it is on the server', () => {
    const totals = inventoryTotals(
      inventory([
        session('a', '2026-06-14T07:30:00.000Z', { photos: 4, measurements: 6 }),
        session('b', '2026-07-12T07:15:00.000Z', { measurements: 3 }),
        session('c', '2026-09-06T07:45:00.000Z', { photos: 4, measurements: 6 }),
      ]),
    );

    // "4 sessions, 8 photos" is checkable. "We take privacy seriously" is not.
    expect(totals.sessionCount).toBe(3);
    expect(totals.photoCount).toBe(8);
    expect(totals.measurementCount).toBe(15);
    expect(totals.sessionsOnServer).toBe(2);
  });

  it('reports zeroes for an athlete with nothing stored', () => {
    expect(inventoryTotals([])).toEqual({
      sessionCount: 0,
      photoCount: 0,
      measurementCount: 0,
      sessionsOnServer: 0,
    });
  });
});

describe('describeContents', () => {
  it('describes a session in plain words', () => {
    const [full, numbersOnly, photosOnly] = inventory([
      session('a', '2026-09-06T07:45:00.000Z', { photos: 4, measurements: 6 }),
      session('b', '2026-07-12T07:15:00.000Z', { measurements: 1 }),
      session('c', '2026-06-14T07:30:00.000Z', { photos: 1 }),
    ]);

    expect(describeContents(full!)).toBe('4 photos · 6 measurements');
    // Singular where it should be singular.
    expect(describeContents(numbersOnly!)).toBe('1 measurement');
    expect(describeContents(photosOnly!)).toBe('1 photo');
  });

  it('says plainly when a session holds nothing', () => {
    expect(describeContents(inventorySession(session('a', '2026-09-06T07:45:00.000Z')))).toBe(
      'Nothing recorded',
    );
  });
});
