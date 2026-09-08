/**
 * Compare sessions.
 *
 * Placeholder for the phase-3 flow (pick two sessions or a date range, photos
 * before and after, trend charts, change summary). It exists so the summary's
 * quick action lands somewhere honest while the flow is being built.
 */

import React from 'react';
import { router } from 'expo-router';

import { spacing } from '../../src/design/tokens';
import { EmptyState, Screen, Stack, Type } from '../../src/components/primitives';

export default function CompareScreen(): React.ReactElement {
  return (
    <Screen>
      <Stack gap={spacing.lg}>
        <Type variant="body" tone="secondary">
          Comparison puts two sessions side by side: the four photos, then the trend in each
          measurement, weight and body-fat estimate.
        </Type>
        <EmptyState
          title="Comparison is not built yet"
          body="Choosing sessions, before-and-after photos and trend charts arrive in a later phase."
          action={{ label: 'Back to summary', onPress: () => router.back() }}
        />
      </Stack>
    </Screen>
  );
}
