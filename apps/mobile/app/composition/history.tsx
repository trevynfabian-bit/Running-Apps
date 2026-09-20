/**
 * Composition history, from the privacy side.
 *
 * This is the screen an athlete opens when the question is "what have you got
 * of mine, and how do I get rid of it". So it leads with an inventory — counts
 * they can check — rather than with reassurance. "4 sessions, 16 photos on our
 * servers" is a statement they can verify against the list below it; "we take
 * your privacy seriously" is not a statement at all.
 *
 * Every row says what that session holds and whether any of it left the device.
 * A row reading only "6 September" would ask someone to decide about deleting
 * something without telling them what the something is.
 *
 * Data is stubbed. Deleting a single session and the sign-out sweep arrive with
 * their own tasks; this is the screen they act on.
 */

import React from 'react';
import { View } from 'react-native';

import { useCompositionSessions } from '../../src/lib/composition-session-store';
import { STUB_SESSION_HISTORY } from '../../src/lib/composition-history-stub';
import {
  describeContents,
  inventory,
  inventoryTotals,
  type SessionInventory,
} from '../../src/lib/composition-inventory';
import { spacing } from '../../src/design/tokens';
import {
  Card,
  Chip,
  Divider,
  EmptyState,
  Screen,
  SectionHeader,
  Stack,
  Type,
} from '../../src/components/primitives';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export default function CompositionHistoryScreen(): React.ReactElement {
  const { all } = useCompositionSessions();
  const entries = inventory(all.length > 0 ? all : STUB_SESSION_HISTORY);
  const totals = inventoryTotals(entries);

  if (entries.length === 0) {
    return (
      <Screen>
        <EmptyState
          title="Nothing stored yet"
          body="You have no composition sessions. Nothing about your body is held on this device or on our servers."
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack gap={spacing.xl}>
        <View>
          <SectionHeader title="What is stored" />
          <Card>
            <Stack gap={spacing.md}>
              {/* Counts, not reassurance. An athlete can check these against
                  the list below; they cannot check a promise. */}
              <Type variant="metricMedium">
                {totals.sessionCount} {totals.sessionCount === 1 ? 'session' : 'sessions'}
              </Type>
              <Type variant="body" tone="secondary">
                {totals.photoCount} {totals.photoCount === 1 ? 'photo' : 'photos'} and{' '}
                {totals.measurementCount}{' '}
                {totals.measurementCount === 1 ? 'measurement' : 'measurements'} in total.
              </Type>
              <Divider />
              <Type variant="caption" tone="tertiary">
                {totals.sessionsOnServer === 0
                  ? 'None of it has left this device. Measurements stay here until you sign in on another one.'
                  : `${totals.sessionsOnServer} of these ${
                      totals.sessionCount === 1 ? 'session' : 'sessions'
                    } include photos, which are held on our servers so they can be read and compared. Everything is sent over an encrypted connection.`}
              </Type>
            </Stack>
          </Card>
        </View>

        <View>
          <SectionHeader title="Sessions" />
          <Card>
            <Stack gap={spacing.md}>
              {entries.map((entry, index) => (
                <React.Fragment key={entry.sessionId}>
                  {index > 0 ? <Divider /> : null}
                  <SessionRow entry={entry} />
                </React.Fragment>
              ))}
            </Stack>
          </Card>
        </View>
      </Stack>
    </Screen>
  );
}

function SessionRow({ entry }: { entry: SessionInventory }): React.ReactElement {
  const onServer = entry.locations.includes('server');
  const when = formatDate(entry.capturedAt);
  const contents = describeContents(entry);

  return (
    <View
      accessible
      accessibilityLabel={`${when}. ${contents}. ${
        onServer ? 'Includes photos held on our servers.' : 'Held on this device only.'
      }`}
    >
      <Stack direction="row" justify="space-between" align="center" gap={spacing.md}>
        <Stack gap={2} style={{ flexShrink: 1 }}>
          <Type variant="bodyStrong" tone={entry.isEmpty ? 'secondary' : 'default'}>
            {when}
          </Type>
          <Type variant="caption" tone="tertiary">
            {contents}
          </Type>
        </Stack>
        {/* Where it lives, in words. A privacy screen is the last place to
            convey something by colour alone. */}
        <Chip
          label={onServer ? 'On our servers' : 'This device'}
          tone={onServer ? 'caution' : 'neutral'}
          selected
        />
      </Stack>
    </View>
  );
}
