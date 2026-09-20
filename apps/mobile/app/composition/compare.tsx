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

import { useCompositionSessions } from '../../src/lib/composition-session-store';
import { useMeasurementUnit } from '../../src/lib/measurement-units';
import {
  RANGE_PRESETS,
  comparablePhotoCount,
  comparableRows,
  comparePhotos,
  compareSessions,
  resolveRange,
  selectSlot,
  sessionsInRange,
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
import { PhotoComparison } from '../../src/components/composition';
import { TrendChart } from '../../src/components/trend-chart';
import { buildTrendSeries, type TrendMetric } from '../../src/lib/composition-trends';
import {
  STUB_BODY_FAT_PERCENT,
  STUB_SESSION_HISTORY,
  STUB_WEIGHT_KG,
} from '../../src/lib/composition-history-stub';
import { STUB_CIRCUMFERENCE_POINTS } from '../../src/lib/body-composition';

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

  /**
   * Two ways to say what to compare.
   *
   * Picking two sessions is precise; picking a window is what someone actually
   * asks for most of the time ("how have the last three months gone?"). Neither
   * is a shortcut for the other, so both are offered rather than one being
   * implemented as a preset of the other.
   */
  const [mode, setMode] = useState<'sessions' | 'range'>('sessions');
  const [rangeKey, setRangeKey] = useState<string>('all');
  const [metric, setMetric] = useState<TrendMetric>({
    kind: 'circumference',
    pointId: STUB_CIRCUMFERENCE_POINTS.find((point) => point.code === 'waist')!.id,
  });

  const [slots, setSlots] = useState(() => ({
    earlierId: sessions[sessions.length - 1]?.id ?? '',
    laterId: sessions[0]?.id ?? '',
  }));

  const preset = RANGE_PRESETS.find((option) => option.key === rangeKey) ?? RANGE_PRESETS.at(-1)!;
  const resolved = resolveRange(sessions, preset.days);
  const inRangeCount = sessionsInRange(sessions, preset.days).length;

  const pair =
    mode === 'range'
      ? resolved
      : (() => {
          const earlierPick = sessions.find((session) => session.id === slots.earlierId);
          const laterPick = sessions.find((session) => session.id === slots.laterId);
          return earlierPick && laterPick ? { earlier: earlierPick, later: laterPick } : undefined;
        })();

  if (sessions.length < 2) {
    return (
      <Screen>
        <EmptyState
          title="Nothing to compare yet"
          body="A comparison needs two sessions. Record another and this screen fills in."
        />
      </Screen>
    );
  }

  const comparison = pair ? compareSessions(pair.earlier, pair.later) : undefined;
  const comparable = comparison ? comparableRows(comparison) : [];
  const photoPairs = comparePhotos(comparison?.earlier, comparison?.later);

  /**
   * The chart always spans the chosen window, even in two-session mode.
   *
   * A trend read from exactly two points is a straight line by construction and
   * says nothing about the shape of the change between them. The pair above
   * answers "what changed"; this answers "how did it get there".
   */
  const series = buildTrendSeries(
    {
      sessions,
      weightKg: STUB_WEIGHT_KG,
      bodyFatPercent: STUB_BODY_FAT_PERCENT,
      points: STUB_CIRCUMFERENCE_POINTS,
    },
    metric,
    preset.days,
  );
  const total = comparison ? totalChangeCm(comparison) : undefined;

  return (
    <Screen>
      <Stack gap={spacing.xl}>
        <View>
          <SectionHeader title="What to compare" />
          <Card>
            <Stack gap={spacing.lg}>
              <Stack direction="row" gap={spacing.sm}>
                <Chip
                  label="Two sessions"
                  selected={mode === 'sessions'}
                  tone={mode === 'sessions' ? 'accent' : 'neutral'}
                  onPress={() => setMode('sessions')}
                />
                <Chip
                  label="Time range"
                  selected={mode === 'range'}
                  tone={mode === 'range' ? 'accent' : 'neutral'}
                  onPress={() => setMode('range')}
                />
              </Stack>

              <Divider />

              {mode === 'sessions' ? (
                <Stack gap={spacing.lg}>
                  <SessionPicker
                    label="Earlier"
                    sessions={sessions}
                    selectedId={slots.earlierId}
                    onSelect={(id) => setSlots((current) => selectSlot(current, 'earlier', id))}
                  />
                  <Divider />
                  <SessionPicker
                    label="Later"
                    sessions={sessions}
                    selectedId={slots.laterId}
                    onSelect={(id) => setSlots((current) => selectSlot(current, 'later', id))}
                  />
                  {/* Picking the session already in the other slot swaps them
                      rather than comparing a session against itself. */}
                  <Type variant="caption" tone="tertiary">
                    Choosing a session already on the other side swaps the two.
                  </Type>
                </Stack>
              ) : (
                <Stack gap={spacing.md}>
                  <Stack direction="row" gap={spacing.sm} style={{ flexWrap: 'wrap' }}>
                    {RANGE_PRESETS.map((option) => (
                      <Chip
                        key={option.key}
                        label={option.label}
                        selected={option.key === preset.key}
                        tone={option.key === preset.key ? 'accent' : 'neutral'}
                        onPress={() => setRangeKey(option.key)}
                      />
                    ))}
                  </Stack>
                  <Type variant="caption" tone="tertiary">
                    {inRangeCount === 0
                      ? 'No sessions in this window.'
                      : inRangeCount === 1
                        ? 'Only one session in this window, so there is nothing to compare it against. Try a longer range.'
                        : `${inRangeCount} sessions in this window. The comparison spans the oldest and newest of them.`}
                  </Type>
                </Stack>
              )}

              {comparison ? (
                <Type variant="caption" tone="secondary">
                  {comparison.daysApart === 0
                    ? 'Both sessions were taken on the same day.'
                    : `${comparison.daysApart} days apart, ${sessionLabel(comparison.earlier)} to ${sessionLabel(comparison.later)}.`}
                </Type>
              ) : null}
            </Stack>
          </Card>
        </View>

        <View>
          <SectionHeader title="Trend" />
          <Card>
            <Stack gap={spacing.lg}>
              {/* One metric at a time: centimetres, kilograms and percent
                  never share an axis. */}
              <Stack direction="row" gap={spacing.sm} style={{ flexWrap: 'wrap' }}>
                {STUB_CIRCUMFERENCE_POINTS.map((point) => (
                  <Chip
                    key={point.id}
                    label={point.label}
                    selected={metric.kind === 'circumference' && metric.pointId === point.id}
                    tone={
                      metric.kind === 'circumference' && metric.pointId === point.id
                        ? 'accent'
                        : 'neutral'
                    }
                    onPress={() => setMetric({ kind: 'circumference', pointId: point.id })}
                  />
                ))}
                <Chip
                  label="Weight"
                  selected={metric.kind === 'weight'}
                  tone={metric.kind === 'weight' ? 'accent' : 'neutral'}
                  onPress={() => setMetric({ kind: 'weight' })}
                />
                <Chip
                  label="Body fat"
                  selected={metric.kind === 'bodyFat'}
                  tone={metric.kind === 'bodyFat' ? 'accent' : 'neutral'}
                  onPress={() => setMetric({ kind: 'bodyFat' })}
                />
              </Stack>

              <Divider />

              {series ? (
                <TrendChart series={series} />
              ) : (
                <Type variant="body" tone="secondary">
                  Nothing recorded for this metric in the chosen window. Try a longer range, or
                  measure it in your next session.
                </Type>
              )}
            </Stack>
          </Card>
        </View>

        {comparison ? (
          <View>
            <SectionHeader title="Before and after" />
            <Stack gap={spacing.md}>
              <PhotoComparison
                pairs={photoPairs}
                earlierLabel={sessionLabel(comparison.earlier)}
                laterLabel={sessionLabel(comparison.later)}
              />
              <Type variant="caption" tone="tertiary">
                {comparablePhotoCount(photoPairs) === 0
                  ? 'Neither session has a photo set that can be paired. Photos are what make a visual comparison possible.'
                  : `${comparablePhotoCount(photoPairs)} of ${photoPairs.length} sides photographed in both sessions.`}
              </Type>
            </Stack>
          </View>
        ) : null}

        {comparison ? (
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
        ) : (
          <EmptyState
            title="Pick a pair to compare"
            body="A time range needs at least two sessions inside it. Widen the range, or choose two sessions directly."
          />
        )}
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
