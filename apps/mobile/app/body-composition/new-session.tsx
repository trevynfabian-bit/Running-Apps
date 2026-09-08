/**
 * New body composition session.
 *
 * Placeholder for the phase-2 flow (pose guidance, four-sided capture, review,
 * then measurements). It exists so the summary's quick action lands somewhere
 * honest rather than on an unmatched route while the flow is being built.
 */

import React from 'react';
import { router } from 'expo-router';

import { spacing } from '../../src/design/tokens';
import { EmptyState, Screen, Stack, Type } from '../../src/components/primitives';

export default function NewSessionScreen(): React.ReactElement {
  return (
    <Screen>
      <Stack gap={spacing.lg}>
        <Type variant="body" tone="secondary">
          A session records the four-sided portrait first, then your tape measurements, and saves
          them together.
        </Type>
        <EmptyState
          title="Photo capture is not built yet"
          body="Pose guidance and the front, back, left and right photos arrive in the next phase. Sessions shown today come from sample data."
          action={{ label: 'Back to summary', onPress: () => router.back() }}
        />
      </Stack>
    </Screen>
  );
}
