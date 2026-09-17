/**
 * Saved composition sessions.
 *
 * STUB — an in-memory list that lives as long as the app process. There is no
 * composition endpoint yet, and a session that vanishes on reload is honest
 * about that in a way a fake persisted store would not be.
 *
 * The shape is the point. A saved session is a draft that has been given an id
 * and a settled capture time, which is exactly what the API will return, so the
 * history screen is already written against the real thing.
 *
 * Replaced by `api.compositionSessions()` and friends when the endpoint lands;
 * nothing outside this module refers to the array.
 */

import type { CompositionPhotoDraft, CompositionSessionDraft } from '@running/core';

export interface SavedCompositionSession {
  id: string;
  /** When the session was captured, not when the row was written. */
  capturedAt: Date;
  photos: readonly CompositionPhotoDraft[];
}

const sessions: SavedCompositionSession[] = [];
let nextId = 1;

/**
 * Persist a draft and hand back the saved session.
 *
 * The caller has already validated the draft; this does not re-check, because
 * a store that silently rejects is worse than one that does not check at all.
 */
export function saveSession(draft: CompositionSessionDraft): SavedCompositionSession {
  const saved: SavedCompositionSession = {
    id: `local-${nextId}`,
    capturedAt: draft.startedAt,
    photos: [...draft.photos],
  };
  nextId += 1;
  sessions.unshift(saved);
  return saved;
}

/** Newest first, which is the order the history reads in. */
export function listSessions(): readonly SavedCompositionSession[] {
  return sessions;
}

export function getSession(id: string): SavedCompositionSession | undefined {
  return sessions.find((session) => session.id === id);
}
