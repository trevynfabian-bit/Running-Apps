/**
 * Every composition session the app currently knows about.
 *
 * Held in context rather than in a screen because the sessions outlive any one
 * route: the photo steps and the circumference steps write into the same
 * in-progress session, and the history list has to reflect a correction the
 * moment it is made, from wherever it was made.
 *
 * Two kinds of session live here and the distinction matters:
 *
 *   `active`   the one being recorded now. It starts lazily, on the first thing
 *              recorded into it, so opening the screen and leaving without
 *              typing anything does not litter the history with an empty one.
 *   `history`  sessions already filed. Seeded from stubs until the API lands.
 *
 * Corrections apply to both, because a value typed wrong is worth fixing
 * whether it was typed a minute ago or in June.
 *
 * Stub-backed: nothing here reaches the API yet. When the endpoints arrive this
 * is the seam — `record` and `amend` become requests and the reducers below
 * stay as the optimistic local copy.
 */

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

import type { LengthUnit } from '@running/core';

import type { BodyMeasurement } from './body-composition';
import {
  addMeasurement,
  amendMeasurement,
  createSession,
  isSessionEmpty,
  measurementForPoint,
  removeMeasurement,
  type BodyCompositionSession,
} from './composition-session';
import { STUB_SESSION_HISTORY } from './composition-history-stub';

export interface MeasurementCorrection {
  valueCm: number;
  recordedUnit: LengthUnit;
}

interface CompositionSessionsValue {
  /** The session being recorded, once anything has been recorded into it. */
  active?: BodyCompositionSession;
  /** Sessions already filed, oldest to newest as the source provides them. */
  history: readonly BodyCompositionSession[];
  /** Active plus history, for callers that just want every session. */
  all: readonly BodyCompositionSession[];
  /**
   * Record a circumference into the active session, starting one if needed.
   * Replaces any earlier value for the same point.
   */
  record: (measurement: Omit<BodyMeasurement, 'id'>) => void;
  /** Correct a value in any session — the active one or a filed one. */
  amend: (sessionId: string, pointId: string, correction: MeasurementCorrection) => void;
  /** Delete a value from any session — the active one or a filed one. */
  remove: (sessionId: string, pointId: string) => void;
  /** Drop a point's measurement from the active session. */
  discard: (pointId: string) => void;
  /** Clear the active session — used when it has been filed or abandoned. */
  reset: () => void;
  /** The value already recorded for a point in the active session, if any. */
  recorded: (pointId: string) => BodyMeasurement | undefined;
}

const CompositionSessionsContext = createContext<CompositionSessionsValue | undefined>(undefined);

/**
 * Local id for a record the server has not seen.
 *
 * A counter rather than a bare timestamp: two measurements saved inside the
 * same millisecond are entirely possible when a value is corrected immediately,
 * and duplicate React keys would make one of them disappear from the list.
 */
let localIdCounter = 0;
function nextLocalId(): string {
  localIdCounter += 1;
  return `local-${Date.now()}-${localIdCounter}`;
}

export function CompositionSessionsProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [active, setActive] = useState<BodyCompositionSession>();
  const [history, setHistory] = useState<readonly BodyCompositionSession[]>(STUB_SESSION_HISTORY);

  const record = useCallback((measurement: Omit<BodyMeasurement, 'id'>) => {
    setActive((current) => {
      // The session is stamped with when it began, not when this measurement
      // landed, so every entry in it shares one documentation moment.
      const base = current ?? createSession(nextLocalId(), measurement.capturedAt);
      return addMeasurement(base, { ...measurement, id: nextLocalId() });
    });
  }, []);

  const amend = useCallback(
    (sessionId: string, pointId: string, correction: MeasurementCorrection) => {
      // The session id decides which list is touched, so a correction can
      // never write a filed value into the session being recorded.
      setActive((current) =>
        current && current.id === sessionId
          ? amendMeasurement(current, pointId, correction)
          : current,
      );

      setHistory((current) => {
        const index = current.findIndex((session) => session.id === sessionId);
        if (index === -1) return current;

        const amended = amendMeasurement(current[index]!, pointId, correction);
        // Nothing to correct: return the same array so React skips the render.
        if (amended === current[index]) return current;

        const next = [...current];
        next[index] = amended;
        return next;
      });
    },
    [],
  );

  const remove = useCallback((sessionId: string, pointId: string) => {
    setActive((current) => {
      if (!current || current.id !== sessionId) return current;

      const trimmed = removeMeasurement(current, pointId);
      // Deleting the only measurement puts the session back to not-started.
      // Sessions begin lazily to avoid empty ones in the history; an emptied
      // one should not survive by having existed briefly.
      return isSessionEmpty(trimmed) ? undefined : trimmed;
    });

    setHistory((current) => {
      const index = current.findIndex((session) => session.id === sessionId);
      if (index === -1) return current;

      const trimmed = removeMeasurement(current[index]!, pointId);
      // Nothing to delete: same array, so React skips the render.
      if (trimmed === current[index]) return current;

      // A filed session that loses its last circumference is kept. It may
      // still hold photos, and discarding a whole session is a separate,
      // explicit action — not a side effect of deleting one number.
      const next = [...current];
      next[index] = trimmed;
      return next;
    });
  }, []);

  const discard = useCallback((pointId: string) => {
    setActive((current) => (current ? removeMeasurement(current, pointId) : current));
  }, []);

  const reset = useCallback(() => setActive(undefined), []);

  const recorded = useCallback(
    (pointId: string) => (active ? measurementForPoint(active, pointId) : undefined),
    [active],
  );

  const all = useMemo(() => (active ? [active, ...history] : history), [active, history]);

  const value = useMemo(
    () => ({ active, history, all, record, amend, remove, discard, reset, recorded }),
    [active, history, all, record, amend, remove, discard, reset, recorded],
  );

  return (
    <CompositionSessionsContext.Provider value={value}>
      {children}
    </CompositionSessionsContext.Provider>
  );
}

export function useCompositionSessions(): CompositionSessionsValue {
  const value = useContext(CompositionSessionsContext);
  if (!value) {
    throw new Error('useCompositionSessions must be used inside a CompositionSessionsProvider');
  }
  return value;
}
