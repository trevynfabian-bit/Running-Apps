/**
 * Body composition display components.
 *
 * Same rule as the training metrics next door: show the number that changes a
 * decision, and let everything else sit one level down. For a composition
 * session the decision is "am I done, and is anything obviously off?", so the
 * summary leads with coverage and gaps rather than with a running log.
 */

import React, { useMemo } from 'react';
import { View } from 'react-native';

import { formatCanonicalLength, formatSignedLength, type LengthUnit } from '@running/core';

import type { BodyMeasurement, CircumferencePoint } from '../lib/body-composition';
import type { MetricHistoryEntry } from '../lib/composition-history';
import { summariseSession, type BodyCompositionSession } from '../lib/composition-session';
import { radius, spacing } from '../design/tokens';
import { useTheme } from '../design/theme';
import { Card, Divider, EmptyState, Stack, Type } from './primitives';

/**
 * Everything this session holds, point by point.
 *
 * Every measure point gets a row whether or not it has a value, because the
 * useful question halfway through a session is which ones are still missing.
 * A log of what was saved cannot answer that — the gaps are exactly what a log
 * leaves out.
 */
export function SessionSummaryCard({
  session,
  points,
  displayUnit,
  highlightPointId,
}: {
  session?: BodyCompositionSession;
  points: readonly CircumferencePoint[];
  displayUnit: LengthUnit;
  /** The point the athlete is currently on, marked so the row is findable. */
  highlightPointId?: string;
}): React.ReactElement {
  const summary = useMemo(() => summariseSession(session, points), [session, points]);

  const startedAt = useMemo(() => {
    if (!session) return undefined;
    return new Date(session.capturedAt).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [session]);

  return (
    <Card>
      <Stack gap={spacing.md}>
        <Stack direction="row" justify="space-between" align="center" gap={spacing.md}>
          <Stack gap={2} style={{ flexShrink: 1 }}>
            <Type variant="bodyStrong">
              {summary.measuredCount} of {summary.totalPoints} points measured
            </Type>
            <Type variant="caption" tone="tertiary">
              {startedAt ? `Started ${startedAt}` : 'Not started — your first save begins it'}
            </Type>
          </Stack>
          {summary.isComplete ? (
            <Type variant="caption" tone="positive">
              All points
            </Type>
          ) : null}
        </Stack>

        <CoverageBar measured={summary.measuredCount} total={summary.totalPoints} />

        <Divider />

        <Stack gap={spacing.md}>
          {summary.rows.map((row, index) => (
            <React.Fragment key={row.point.id}>
              {index > 0 ? <Divider /> : null}
              <SummaryRow
                point={row.point}
                measurement={row.measurement}
                displayUnit={displayUnit}
                isCurrent={row.point.id === highlightPointId}
              />
            </React.Fragment>
          ))}
        </Stack>
      </Stack>
    </Card>
  );
}

/**
 * How much of the session is done.
 *
 * Paired with the "N of M" text above it rather than standing alone — the bar
 * is for the glance, the text is what a screen reader gets, and neither has to
 * carry the meaning by itself.
 */
function CoverageBar({ measured, total }: { measured: number; total: number }): React.ReactElement {
  const theme = useTheme();
  const fraction = total > 0 ? Math.min(1, measured / total) : 0;

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        height: 6,
        borderRadius: radius.pill,
        backgroundColor: theme.color.border,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          width: `${fraction * 100}%`,
          height: '100%',
          borderRadius: radius.pill,
          backgroundColor: fraction === 1 ? theme.color.positive : theme.color.accent,
        }}
      />
    </View>
  );
}

/**
 * One point's row in the summary.
 *
 * A measured point shows its value in the athlete's current default unit, and
 * notes the original when the two differ — without that note a set of entries
 * looks inconsistent for no visible reason the first time someone switches
 * their default. An unmeasured point shows a dash and says so in words, because
 * a dash on its own is ambiguous between "nothing yet" and "zero".
 */
function SummaryRow({
  point,
  measurement,
  displayUnit,
  isCurrent,
}: {
  point: CircumferencePoint;
  measurement?: BodyMeasurement;
  displayUnit: LengthUnit;
  isCurrent: boolean;
}): React.ReactElement {
  const capturedAt = useMemo(() => {
    if (!measurement) return undefined;
    return new Date(measurement.capturedAt).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [measurement]);

  const converted = measurement !== undefined && measurement.recordedUnit !== displayUnit;

  const detail = measurement
    ? converted
      ? `${capturedAt} · recorded as ${formatCanonicalLength(
          measurement.valueCm,
          measurement.recordedUnit,
        )}`
      : capturedAt
    : 'Not measured yet';

  const reading = measurement
    ? formatCanonicalLength(measurement.valueCm, displayUnit)
    : 'not measured yet';

  return (
    // One element for the whole row, so a screen reader reads
    // "Waist, 86.4 cm" instead of three disconnected fragments — and so the
    // em-dash, which announces as nothing useful, is replaced by words.
    <View accessible accessibilityLabel={`${point.label}, ${reading}`}>
      <Stack direction="row" justify="space-between" align="center" gap={spacing.md}>
        <Stack gap={2} style={{ flexShrink: 1 }}>
          <Type variant="bodyStrong" tone={measurement ? 'default' : 'secondary'}>
            {point.label}
            {isCurrent ? ' · editing' : ''}
          </Type>
          <Type variant="caption" tone="tertiary">
            {detail}
          </Type>
        </Stack>
        <Type variant="metricSmall" tone={measurement ? 'default' : 'tertiary'}>
          {measurement ? formatCanonicalLength(measurement.valueCm, displayUnit) : '—'}
        </Type>
      </Stack>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Per-metric history
// ---------------------------------------------------------------------------

/**
 * One measure point's values over time.
 *
 * Each row states its change from the session before it, because a column of
 * numbers makes the reader do the subtraction to find the only thing they came
 * for. The change is rendered in the athlete's current unit but computed in
 * centimetres, so a session typed in inches does not produce a fictional jump.
 *
 * The direction is shown without being judged. A waist coming down and an arm
 * coming down are not the same news, and the app cannot know which one the
 * athlete was training for — so the arrow says which way, the colour stays
 * neutral, and the athlete supplies the meaning.
 */
export function MetricHistoryCard({
  pointLabel,
  entries,
  displayUnit,
}: {
  pointLabel: string;
  entries: readonly MetricHistoryEntry[];
  displayUnit: LengthUnit;
}): React.ReactElement {
  if (entries.length === 0) {
    return (
      <EmptyState
        title={`No ${pointLabel.toLowerCase()} history yet`}
        body="Once you have measured this point in more than one session, the values and the change between them show up here."
      />
    );
  }

  return (
    <Card>
      <Stack gap={spacing.md}>
        {entries.map((entry, index) => (
          <React.Fragment key={entry.sessionId}>
            {index > 0 ? <Divider /> : null}
            <HistoryRow entry={entry} displayUnit={displayUnit} isLatest={index === 0} />
          </React.Fragment>
        ))}
      </Stack>
    </Card>
  );
}

function HistoryRow({
  entry,
  displayUnit,
  isLatest,
}: {
  entry: MetricHistoryEntry;
  displayUnit: LengthUnit;
  isLatest: boolean;
}): React.ReactElement {
  const when = useMemo(
    () =>
      new Date(entry.capturedAt).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }),
    [entry.capturedAt],
  );

  const reading = formatCanonicalLength(entry.valueCm, displayUnit);

  const change =
    entry.changeCm === undefined
      ? undefined
      : {
          // Arrow and text both, so the direction survives a screen reader and
          // a colour-blind glance alike.
          arrow: entry.changeCm < 0 ? '\u2193' : entry.changeCm > 0 ? '\u2191' : '\u2192',
          label: formatSignedLength(entry.changeCm, displayUnit),
        };

  return (
    <View
      accessible
      accessibilityLabel={
        change
          ? `${when}, ${reading}, ${change.label} from the session before`
          : `${when}, ${reading}, first recorded`
      }
    >
      <Stack direction="row" justify="space-between" align="center" gap={spacing.md}>
        <Stack gap={2} style={{ flexShrink: 1 }}>
          <Type variant="bodyStrong">{when}</Type>
          <Type variant="caption" tone="tertiary">
            {entry.recordedUnit === displayUnit
              ? isLatest
                ? 'Most recent'
                : 'Recorded'
              : `Recorded as ${formatCanonicalLength(entry.valueCm, entry.recordedUnit)}`}
          </Type>
        </Stack>
        <Stack gap={2} align="flex-end">
          <Type variant="metricSmall">{reading}</Type>
          <Type variant="caption" tone="secondary">
            {change ? `${change.arrow} ${change.label}` : 'First recorded'}
          </Type>
        </Stack>
      </Stack>
    </View>
  );
}
