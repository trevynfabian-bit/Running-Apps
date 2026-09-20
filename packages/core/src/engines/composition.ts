/**
 * Body composition calculations.
 *
 * Pure and deterministic like the rest of the engines: no clock, no ids
 * generated here, no I/O. Both the API and the mobile app compute a measure
 * point's history through this, so the number an athlete sees on their phone
 * and the number the server reports are the same number by construction rather
 * than by two implementations agreeing for now.
 */

/** The minimum a value needs to carry for a change to be computed from it. */
export interface CompositionReading {
  /** When the session it belongs to was taken. ISO-8601. */
  capturedAt: string;
  /** Canonical centimetres. Deltas are meaningless in mixed units. */
  valueCm: number;
}

export type WithChange<T> = T & {
  /**
   * Change in centimetres from the next-older reading. Undefined when there is
   * no older reading to compare against — which is not the same as a change of
   * exactly zero, and the two must stay distinguishable.
   */
  changeCm?: number;
};

/**
 * Order readings newest-first and attach each one's change from the reading
 * before it.
 *
 * Sorting here rather than trusting the caller: the API orders in SQL, the app
 * concatenates an in-progress session onto a fetched list, and a delta computed
 * against the wrong neighbour is wrong in a way nothing downstream can detect.
 *
 * `olderNeighbour` exists for pagination. A page of ten readings has an
 * eleventh behind it, and the oldest row *on the page* still deserves its
 * change — otherwise a value's delta would appear and disappear depending on
 * where the page boundary happened to fall. Callers fetch one extra row and
 * pass it here.
 */
export function withChanges<T extends CompositionReading>(
  readings: readonly T[],
  olderNeighbour?: CompositionReading,
): WithChange<T>[] {
  const ordered = [...readings].sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));

  return ordered.map((reading, index) => {
    // The array is newest-first, so the older neighbour is the next index —
    // falling off the end onto the caller's extra row, if it supplied one.
    const older = ordered[index + 1] ?? olderNeighbour;

    return older ? { ...reading, changeCm: reading.valueCm - older.valueCm } : { ...reading };
  });
}

/**
 * Net change across a whole series, oldest to newest.
 *
 * Undefined for fewer than two readings: one measurement is a position, not a
 * direction, and reporting it as "no change" would be a claim the data does not
 * support.
 */
export function netChangeCm(readings: readonly CompositionReading[]): number | undefined {
  if (readings.length < 2) return undefined;

  const ordered = [...readings].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));

  return ordered[ordered.length - 1]!.valueCm - ordered[0]!.valueCm;
}
