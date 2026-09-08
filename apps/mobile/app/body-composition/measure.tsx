/**
 * Log tape measurements.
 *
 * Placeholder for the phase-2 flow (pick a point, read the tape guide, enter a
 * value in cm or inches, browse the per-point history). It exists so the
 * summary's quick action lands somewhere honest while the flow is being built.
 */

import React from 'react';
import { router } from 'expo-router';

import { spacing } from '../../src/design/tokens';
import { EmptyState, Screen, Stack, Type } from '../../src/components/primitives';

export default function MeasureScreen(): React.ReactElement {
  return (
    <Screen>
      <Stack gap={spacing.lg}>
        <Type variant="body" tone="secondary">
          Measurements are taken at fixed points with a tape, in centimetres or inches, and kept per
          point over time.
        </Type>
        <EmptyState
          title="Measurement entry is not built yet"
          body="Choosing a point, reading the tape guide and entering a value arrive in the next phase. Values shown today come from sample data."
          action={{ label: 'Back to summary', onPress: () => router.back() }}
        />
      </Stack>
    </Screen>
  );
}
