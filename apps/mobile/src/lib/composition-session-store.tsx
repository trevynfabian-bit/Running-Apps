/**
 * The session currently being recorded.
 *
 * Held in context rather than in the entry screen so the session outlives any
 * one screen: the photo steps and the circumference steps are separate routes
 * writing into the same session, and an athlete who backs out to check a guide
 * and returns must not find their work gone.
 *
 * A session starts lazily, on the first thing recorded into it. Opening the
 * screen and leaving without typing anything should not litter the history with
 * an empty session.
 *
 * Stub-backed: nothing here reaches the API yet. When the endpoints land, this
 * is the seam — `record` becomes a POST and the reducer below stays as the
 * optimistic local copy.
 */

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

import type { BodyMeasurement } from './body-composition';
import {
  addMeasurement,
  createSession,
  measurementForPoint,
  removeMeasurement,
  type BodyCompositionSession,
} from './composition-session';

interface ActiveSessionValue {
  /** Undefined until the athlete records something. */
  session?: BodyCompositionSession;
  /**
   * Record a circumference into the active session, starting one if needed.
   * Replaces any earlier value for the same point.
   */
  record: (measurement: Omit<BodyMeasurement, 'id'>) => void;
  /** Drop a point's measurement from the active session. */
  discard: (pointId: string) => void;
  /** Clear the session entirely — used when it has been saved or abandoned. */
  reset: () => void;
  /** The value already recorded for a point in this session, if any. */
  recorded: (pointId: string) => BodyMeasurement | undefined;
}

const ActiveSessionContext = createContext<ActiveSessionValue | undefined>(undefined);

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

export function ActiveSessionProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [session, setSession] = useState<BodyCompositionSession>();

  const record = useCallback((measurement: Omit<BodyMeasurement, 'id'>) => {
    setSession((current) => {
      // The session is stamped with when it began, not when this measurement
      // landed, so every entry in it shares one documentation moment.
      const base = current ?? createSession(nextLocalId(), measurement.capturedAt);
      return addMeasurement(base, { ...measurement, id: nextLocalId() });
    });
  }, []);

  const discard = useCallback((pointId: string) => {
    setSession((current) => (current ? removeMeasurement(current, pointId) : current));
  }, []);

  const reset = useCallback(() => setSession(undefined), []);

  const recorded = useCallback(
    (pointId: string) => (session ? measurementForPoint(session, pointId) : undefined),
    [session],
  );

  const value = useMemo(
    () => ({ session, record, discard, reset, recorded }),
    [session, record, discard, reset, recorded],
  );

  return <ActiveSessionContext.Provider value={value}>{children}</ActiveSessionContext.Provider>;
}

export function useActiveSession(): ActiveSessionValue {
  const value = useContext(ActiveSessionContext);
  if (!value) {
    throw new Error('useActiveSession must be used inside an ActiveSessionProvider');
  }
  return value;
}
