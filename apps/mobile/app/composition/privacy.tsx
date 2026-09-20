/**
 * Where composition data lives, and what removes it.
 *
 * Organised by location rather than by policy heading, because the question an
 * athlete actually has is "what is on my phone and what is on your servers",
 * not "what is your retention posture". Each statement names a mechanism they
 * could check rather than a sentiment they have to accept.
 *
 * The statements themselves live beside the code they describe, so a test can
 * hold them to that standard.
 */

import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

import { DEVICE_FACTS, SERVER_FACTS, type PrivacyFact } from '../../src/lib/privacy-facts';
import { useCompositionSessions } from '../../src/lib/composition-session-store';
import { STUB_SESSION_HISTORY } from '../../src/lib/composition-history-stub';
import { inventory, inventoryTotals } from '../../src/lib/composition-inventory';
import { spacing } from '../../src/design/tokens';
import {
  Button,
  Card,
  Divider,
  Screen,
  SectionHeader,
  Stack,
  Type,
} from '../../src/components/primitives';

export default function CompositionPrivacyScreen(): React.ReactElement {
  const { all } = useCompositionSessions();
  const totals = inventoryTotals(inventory(all.length > 0 ? all : STUB_SESSION_HISTORY));

  return (
    <Screen>
      <Stack gap={spacing.xl}>
        <Card>
          <Stack gap={spacing.md}>
            <Type variant="heading" accessibilityRole="header">
              What you have stored
            </Type>
            {/* The page opens with their own numbers rather than with policy.
                A concrete count is the one part of a privacy page an athlete
                can verify immediately. */}
            <Type variant="body" tone="secondary">
              {totals.sessionCount === 0
                ? 'Nothing yet. No photos, no measurements, on this device or on our servers.'
                : `${totals.sessionCount} ${
                    totals.sessionCount === 1 ? 'session' : 'sessions'
                  }: ${totals.photoCount} ${
                    totals.photoCount === 1 ? 'photo' : 'photos'
                  } and ${totals.measurementCount} ${
                    totals.measurementCount === 1 ? 'measurement' : 'measurements'
                  }.`}
            </Type>
            <Button
              label="See and delete your sessions"
              onPress={() => router.push('/composition/history')}
              variant="secondary"
            />
          </Stack>
        </Card>

        <View>
          <SectionHeader title="On our servers" />
          <FactList facts={SERVER_FACTS} />
        </View>

        <View>
          <SectionHeader title="On this device" />
          <FactList facts={DEVICE_FACTS} />
        </View>
      </Stack>
    </Screen>
  );
}

function FactList({ facts }: { facts: readonly PrivacyFact[] }): React.ReactElement {
  return (
    <Card>
      <Stack gap={spacing.lg}>
        {facts.map((fact, index) => (
          <React.Fragment key={fact.title}>
            {index > 0 ? <Divider /> : null}
            <Stack gap={spacing.xs}>
              <Type variant="bodyStrong" accessibilityRole="header">
                {fact.title}
              </Type>
              <Type variant="body" tone="secondary">
                {fact.detail}
              </Type>
            </Stack>
          </React.Fragment>
        ))}
      </Stack>
    </Card>
  );
}
