/**
 * The "Why?" modal.
 *
 * Reached from any recommendation in the app. It renders the explanation the
 * deterministic coaching engine generated — the same text whether or not a
 * language model is configured, because the reasoning belongs to the engine.
 */

import React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { spacing } from '../src/design/tokens';
import { Card, Screen, Stack, Type } from '../src/components/primitives';

export default function WhyScreen(): React.ReactElement {
  const params = useLocalSearchParams<{ title?: string; explanation?: string }>();

  return (
    <Screen>
      <Stack gap={spacing.lg}>
        <Type variant="title">{params.title ?? 'Why this recommendation?'}</Type>

        <Card>
          <Type variant="body" style={{ lineHeight: 24 }}>
            {params.explanation ?? 'No explanation is available for this recommendation.'}
          </Type>
        </Card>

        <Card>
          <Stack gap={spacing.sm}>
            <Type variant="bodyStrong">How decisions are made</Type>
            <Type variant="body" tone="secondary">
              Your training recommendation is calculated by a deterministic engine from your
              recovery signals, training load and plan — not by a language model. The same inputs
              always produce the same decision, and every decision can be traced to the signals
              above.
            </Type>
          </Stack>
        </Card>
      </Stack>
    </Screen>
  );
}
