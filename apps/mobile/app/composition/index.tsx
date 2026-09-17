/**
 * Body composition history.
 *
 * The list of sessions, newest first, and the way into a new one. A session is
 * only useful next to the ones before it, so the history is the home of this
 * feature rather than a screen hanging off the capture flow.
 *
 * Reads the in-memory stub store, so sessions last as long as the app process.
 * The comparison and body-fat screens attach here once they exist; for now a
 * session opens nothing, because there is nothing yet to open.
 */

import React, { useState } from 'react';
import { useFocusEffect, router } from 'expo-router';

import { COMPOSITION_SIDES, COMPOSITION_SIDE_LABELS } from '@running/core';

import { listSessions, type SavedCompositionSession } from '../../src/lib/composition-store';
import { spacing } from '../../src/design/tokens';
import {
  Button,
  Card,
  EmptyState,
  Screen,
  SectionHeader,
  Stack,
  Type,
} from '../../src/components/primitives';
import { SidePhotoTile, describeSessionDate } from '../../src/components/composition';

export default function CompositionHistoryScreen(): React.ReactElement {
  const [sessions, setSessions] = useState<readonly SavedCompositionSession[]>(() =>
    listSessions(),
  );

  // Re-read on focus rather than on mount: coming back from a session that was
  // just saved must show it, and the store has no way to announce itself.
  useFocusEffect(
    React.useCallback(() => {
      setSessions([...listSessions()]);
    }, []),
  );

  return (
    <Screen>
      <Stack gap={spacing.xl}>
        <Stack gap={spacing.xs}>
          <Type variant="title">Body composition</Type>
          <Type variant="body" tone="secondary">
            Four angles and a set of measurements, taken the same way each time, so the change is
            the only thing that differs between them.
          </Type>
        </Stack>

        <Button label="New session" onPress={() => router.push('/composition/session')} />

        {sessions.length === 0 ? (
          <EmptyState
            title="No sessions yet"
            body="The first one is the baseline. It tells you nothing on its own, which is the point of taking it now rather than later."
          />
        ) : (
          <Stack>
            <SectionHeader
              title={`${sessions.length} session${sessions.length === 1 ? '' : 's'}`}
            />
            <Stack gap={spacing.md}>
              {sessions.map((session) => (
                <SessionRow key={session.id} session={session} />
              ))}
            </Stack>
          </Stack>
        )}
      </Stack>
    </Screen>
  );
}

function SessionRow({ session }: { session: SavedCompositionSession }): React.ReactElement {
  return (
    <Card>
      <Stack gap={spacing.md}>
        <Stack gap={2}>
          <Type variant="bodyStrong">{describeSessionDate(session.capturedAt)}</Type>
          <Type variant="caption" tone="tertiary">
            {session.photos.length} of {COMPOSITION_SIDES.length} angles
          </Type>
        </Stack>

        <Stack direction="row" gap={spacing.sm}>
          {COMPOSITION_SIDES.map((side) => (
            <SidePhotoTile
              key={side}
              side={side}
              photo={session.photos.find((photo) => photo.side === side)}
            />
          ))}
        </Stack>

        <Type variant="caption" tone="tertiary">
          {COMPOSITION_SIDE_LABELS.front}, {COMPOSITION_SIDE_LABELS.back},{' '}
          {COMPOSITION_SIDE_LABELS.left.toLowerCase()} and{' '}
          {COMPOSITION_SIDE_LABELS.right.toLowerCase()}.
        </Type>
      </Stack>
    </Card>
  );
}
