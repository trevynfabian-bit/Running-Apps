/**
 * Compare two composition sessions.
 *
 * The screen exists because a single session answers almost nothing. A waist of
 * 85.3 cm is a fact with no meaning attached; 85.3 against 88.2 twelve weeks
 * earlier is the thing the athlete actually wanted to know.
 *
 * Two rules shape what it shows. A point measured in one session and not the
 * other has no change — not a change of zero, which would read as three months
 * of nothing happening. And a direction is reported without a verdict: a waist
 * coming down and an arm coming down are not the same news, and the app cannot
 * know which the athlete was training for.
 *
 * Data is stubbed. Photos and the trend chart arrive with their own tasks; this
 * is the frame they hang on.
 */

import React, { useState } from 'react';
import { View } from 'react-native';

import { formatCanonicalLength, formatSignedLength } from '@running/core';

import { STUB_SESSION_HISTORY } from '../../src/lib/composition-history-stub';
import { useCompositionSessions } from '../../src/lib/composition-session-store';
import { useMeasurementUnit } from '../../src/lib/measurement-units';
import {
  comparableRows,
  compareSessions,
  totalChangeCm,
  type ComparisonRow,
} from '../../src/lib/composition-compare';
import type { BodyCompositionSession } from '../../src/lib/composition-session';
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

function sessionLabel(session: BodyCompositionSession): string {
  return new Date(session.capturedAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export default function CompareScreen(): React.ReactElement {
  const { defaultUnit } = useMeasurementUnit();
  const { all } = useCompositionSessions();

  // Newest first, so the two defaults below are the most recent pair.
  const sessions = [...(all.length > 0 ? all : STUB_SESSION_HISTORY)].sort(
    (a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt),
  );

  const [laterId, setLaterId] = useState(() => sessions[0]?.id);
  const [earlierId, setEarlierId] = useState(() => sessions[sessions.length - 1]?.id);

  const later = sessions.find((session) => session.id === laterId);
  const earlier = sessions.find((session) => session.id === earlierId);

  if (sessions.length < 2 || !later || !earlier) {
    return (
      <Screen>
        <EmptyState
          title="Nothing to compare yet"
          body="A comparison needs two sessions. Record another and this screen fills in."
        />
      </Screen>
    );
  }

  const comparison = compareSessions(earlier, later);
  const comparable = comparableRows(comparison);
  const total = totalChangeCm(comparison);

  return (
    <Screen>
      <Stack gap={spacing.xl}>
        <View>
          <SectionHeader title="Sessions" />
          <Card>
            <Stack gap={spacing.lg}>
              <SessionPicker
                label="Earlier"
                sessions={sessions}
                selectedId={comparison.earlier.id}
                onSelect={setEarlierId}
              />
              <Divider />
              <SessionPicker
                label="Later"
                sessions={sessions}
                selectedId={comparison.later.id}
                onSelect={setLaterId}
              />
              <Type variant="caption" tone="tertiary">
                {comparison.daysApart === 0
                  ? 'Both sessions were taken on the same day.'
                  : `${comparison.daysApart} days apart, ${sessionLabel(comparison.earlier)} to ${sessionLabel(comparison.later)}.`}
              </Type>
            </Stack>
          </Card>
        </View>

        <View>
          <SectionHeader title="What changed" />
          <Card>
            <Stack gap={spacing.lg}>
              <Type variant="body" tone="secondary">
                {comparable.length === 0
                  ? 'These two sessions share no measure point, so there is nothing to compare. Measuring the same points in both is what makes a comparison possible.'
                  : `${comparable.length} of ${comparison.rows.length} points measured in both sessions.`}
              </Type>

              {total !== undefined ? (
                <Stack gap={spacing.xs}>
                  <Type variant="overline" tone="tertiary" accessibilityRole="header">
                    TOTAL ACROSS THOSE POINTS
                  </Type>
                  {/* Neutral tone throughout: the app cannot know whether a
                      total coming down is the news the athlete wanted. */}
                  <Type variant="metricMedium">{formatSignedLength(total, defaultUnit)}</Type>
                </Stack>
              ) : null}

              <Divider />

              <Stack gap={spacing.md}>
                {comparison.rows.map((row, index) => (
                  <React.Fragment key={row.point.id}>
                    {index > 0 ? <Divider /> : null}
                    <ChangeRow row={row} displayUnit={defaultUnit} />
                  </React.Fragment>
                ))}
              </Stack>
            </Stack>
          </Card>
        </View>
      </Stack>
    </Screen>
  );
}

function SessionPicker({
  label,
  sessions,
  selectedId,
  onSelect,
}: {
  label: string;
  sessions: readonly BodyCompositionSession[];
  selectedId: string;
  onSelect: (id: string) => void;
}): React.ReactElement {
  return (
    <Stack gap={spacing.sm}>
      <Type variant="overline" tone="tertiary" accessibilityRole="header">
        {label.toUpperCase()}
      </Type>
      <Stack direction="row" gap={spacing.sm} style={{ flexWrap: 'wrap' }}>
        {sessions.map((session) => (
          <Chip
            key={session.id}
            label={sessionLabel(session)}
            selected={session.id === selectedId}
            tone={session.id === selectedId ? 'accent' : 'neutral'}
            onPress={() => onSelect(session.id)}
          />
        ))}
      </Stack>
    </Stack>
  );
}

/**
 * One point's change.
 *
 * Three states, and the middle one is the reason this component exists: a point
 * measured in only one of the two sessions shows its value and says plainly
 * that there is nothing to compare it against, rather than reporting a change
 * of zero.
 */
function ChangeRow({
  row,
  displayUnit,
}: {
  row: ComparisonRow;
  displayUnit: 'cm' | 'in';
}): React.ReactElement {
  const detail =
    row.changeCm !== undefined
      ? `${formatCanonicalLength(row.fromCm!, displayUnit)} → ${formatCanonicalLength(row.toCm!, displayUnit)}`
      : row.toCm !== undefined
        ? `Only in the later session, ${formatCanonicalLength(row.toCm, displayUnit)}`
        : row.fromCm !== undefined
          ? `Only in the earlier session, ${formatCanonicalLength(row.fromCm, displayUnit)}`
          : 'Not measured in either session';

  const reading = row.changeCm !== undefined ? formatSignedLength(row.changeCm, displayUnit) : '—';

  const arrow =
    row.changeCm === undefined ? '' : row.changeCm < 0 ? '↓ ' : row.changeCm > 0 ? '↑ ' : '→ ';

  return (
    <View
      accessible
      accessibilityLabel={
        row.changeCm !== undefined
          ? `${row.point.label}, ${reading}. ${detail}`
          : `${row.point.label}, no change to report. ${detail}`
      }
    >
      <Stack direction="row" justify="space-between" align="center" gap={spacing.md}>
        <Stack gap={2} style={{ flexShrink: 1 }}>
          <Type variant="bodyStrong" tone={row.changeCm !== undefined ? 'default' : 'secondary'}>
            {row.point.label}
          </Type>
          <Type variant="caption" tone="tertiary">
            {detail}
          </Type>
        </Stack>
        {/* Direction without a verdict: the arrow says which way, the colour
            stays neutral, and the athlete supplies the meaning. */}
        <Type variant="metricSmall" tone={row.changeCm !== undefined ? 'default' : 'tertiary'}>
          {arrow}
          {reading}
        </Type>
      </Stack>
    </View>
  );
}
