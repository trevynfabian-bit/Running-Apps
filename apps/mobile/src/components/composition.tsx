/**
 * Body composition display components.
 *
 * Same rule as the training metrics next door: show the number that changes a
 * decision, and let everything else sit one level down. For a composition
 * session the decision is "am I done, and is anything obviously off?", so the
 * summary leads with coverage and gaps rather than with a running log.
 */

import React, { useMemo, useState } from 'react';
import { Alert, Image, Pressable, StyleSheet, TextInput, View } from 'react-native';

import {
  formatCanonicalLength,
  fromCanonicalLength,
  formatSignedLength,
  parseLength,
  toCanonicalLength,
  type LengthUnit,
  type NavyEstimate,
} from '@running/core';

import {
  SIDE_LABELS,
  type BodyMeasurement,
  type CircumferencePoint,
  type CompositionPhoto,
} from '../lib/body-composition';
import type { PhotoPair } from '../lib/composition-compare';
import type { MetricHistoryEntry } from '../lib/composition-history';
import {
  BODY_FAT_SCALE,
  CONFIDENCE_LABELS,
  NON_MEDICAL_NOTE,
  bandGeometry,
  formatRange,
  rangeWidth,
  type BodyFatEstimate,
} from '../lib/body-fat';
import type { AvailabilityMessage } from '../lib/body-fat';
import {
  FORMULA_VARIANTS,
  VARIANT_DESCRIPTIONS,
  VARIANT_LABELS,
  VARIANT_NOTE,
  type FormulaVariant,
  type Requirement,
} from '../lib/body-fat-inputs';
import { summariseSession, type BodyCompositionSession } from '../lib/composition-session';
import { UNIT_OPTIONS } from '../lib/measurement-units';
import { radius, spacing } from '../design/tokens';
import { useTheme } from '../design/theme';
import { Button, Card, Chip, Divider, EmptyState, Stack, Type } from './primitives';

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
 *
 * Any row can be corrected or deleted in place. A number typed wrong three
 * months ago is still wrong, and it is dragging every delta computed from it
 * along with it — so the fix belongs here, on the row showing the bad value,
 * rather than behind a separate screen the athlete has to go find.
 */
export function MetricHistoryCard({
  pointLabel,
  entries,
  displayUnit,
  onCorrect,
  onDelete,
}: {
  pointLabel: string;
  entries: readonly MetricHistoryEntry[];
  displayUnit: LengthUnit;
  /** Save a corrected value for one session's entry. */
  onCorrect: (sessionId: string, correction: { valueCm: number; recordedUnit: LengthUnit }) => void;
  /** Delete one session's value for this point. */
  onDelete: (sessionId: string) => void;
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
            <HistoryRow
              entry={entry}
              displayUnit={displayUnit}
              isLatest={index === 0}
              pointLabel={pointLabel}
              onCorrect={(correction) => onCorrect(entry.sessionId, correction)}
              onDelete={() => onDelete(entry.sessionId)}
            />
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
  pointLabel,
  onCorrect,
  onDelete,
}: {
  entry: MetricHistoryEntry;
  displayUnit: LengthUnit;
  isLatest: boolean;
  pointLabel: string;
  onCorrect: (correction: { valueCm: number; recordedUnit: LengthUnit }) => void;
  onDelete: () => void;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);

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

  if (editing) {
    return (
      <CorrectionEditor
        entry={entry}
        when={when}
        pointLabel={pointLabel}
        displayUnit={displayUnit}
        onCancel={() => setEditing(false)}
        onSave={(correction) => {
          onCorrect(correction);
          setEditing(false);
        }}
        onDelete={() => {
          setEditing(false);
          onDelete();
        }}
      />
    );
  }

  return (
    <Stack direction="row" justify="space-between" align="center" gap={spacing.md}>
      <View
        accessible
        accessibilityLabel={
          change
            ? `${when}, ${reading}, ${change.label} from the session before`
            : `${when}, ${reading}, first recorded`
        }
        style={{ flexShrink: 1 }}
      >
        <Stack gap={2}>
          <Type variant="bodyStrong">{when}</Type>
          <Type variant="caption" tone="tertiary">
            {entry.recordedUnit === displayUnit
              ? isLatest
                ? 'Most recent'
                : 'Recorded'
              : `Recorded as ${formatCanonicalLength(entry.valueCm, entry.recordedUnit)}`}
          </Type>
        </Stack>
      </View>

      <Stack direction="row" align="center" gap={spacing.md}>
        <Stack gap={2} align="flex-end">
          <Type variant="metricSmall">{reading}</Type>
          <Type variant="caption" tone="secondary">
            {change ? `${change.arrow} ${change.label}` : 'First recorded'}
          </Type>
        </Stack>
        <Pressable
          onPress={() => setEditing(true)}
          accessibilityRole="button"
          // Names the row, so a screen reader hears which value this edits
          // rather than seven identical "Edit" buttons.
          accessibilityLabel={`Correct the ${when} measurement, currently ${reading}`}
          hitSlop={8}
          style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' }}
        >
          <Type variant="caption" tone="accent">
            Edit
          </Type>
        </Pressable>
      </Stack>
    </Stack>
  );
}

/**
 * Correct one recorded value, in place.
 *
 * Opens on the number as it was actually typed, in the unit it was typed in.
 * Showing a converted value here would invite the athlete to re-enter a
 * rounding of their own measurement — correcting a typo must not quietly move
 * the number by a tenth.
 */
function CorrectionEditor({
  entry,
  when,
  pointLabel,
  displayUnit,
  onSave,
  onCancel,
  onDelete,
}: {
  entry: MetricHistoryEntry;
  when: string;
  pointLabel: string;
  displayUnit: LengthUnit;
  onSave: (correction: { valueCm: number; recordedUnit: LengthUnit }) => void;
  onCancel: () => void;
  onDelete: () => void;
}): React.ReactElement {
  const theme = useTheme();

  // What the field opens on, kept so an untouched editor can be recognised.
  const initialValue = fromCanonicalLength(entry.valueCm, entry.recordedUnit).toFixed(1);

  const [unit, setUnit] = useState<LengthUnit>(entry.recordedUnit);
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string>();

  const save = (): void => {
    const parsed = parseLength(value);
    if (parsed === undefined) {
      setError('Enter a measurement as a number, for example 86.4.');
      return;
    }

    // Opening the editor and saving without touching anything must not change
    // the stored value. The field shows one decimal, so writing it back would
    // push the canonical number by a rounding step — a silent edit to data the
    // athlete never touched. Nothing changed, so nothing is written.
    if (value.trim() === initialValue && unit === entry.recordedUnit) {
      onCancel();
      return;
    }

    onSave({ valueCm: toCanonicalLength(parsed, unit), recordedUnit: unit });
  };

  /**
   * Deleting is destructive and there is no undo, so it asks first — and the
   * question names the point, the date and the value, because the athlete is
   * looking at a list of near-identical rows and the only thing that makes
   * this one the right one is those three facts.
   */
  const confirmDelete = (): void => {
    Alert.alert(
      `Delete this ${pointLabel.toLowerCase()} measurement?`,
      `The ${formatCanonicalLength(entry.valueCm, displayUnit)} recorded on ${when} will be removed from that session. Other measurements in it are kept.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: onDelete },
      ],
    );
  };

  return (
    <Stack gap={spacing.md}>
      <Type variant="bodyStrong">Correcting {when}</Type>

      <Stack direction="row" gap={spacing.sm} align="center">
        <TextInput
          value={value}
          onChangeText={(next) => {
            setValue(next);
            if (error) setError(undefined);
          }}
          keyboardType="decimal-pad"
          inputMode="decimal"
          autoFocus
          selectTextOnFocus
          placeholderTextColor={theme.color.textTertiary}
          accessibilityLabel={`Corrected measurement for ${when}, in ${unit}`}
          returnKeyType="done"
          onSubmitEditing={save}
          style={{
            flex: 1,
            minHeight: 48,
            paddingHorizontal: spacing.md,
            borderRadius: radius.md,
            backgroundColor: theme.color.surfaceRaised,
            color: theme.color.text,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.color.borderStrong,
            fontVariant: ['tabular-nums' as const],
          }}
        />
        <View style={{ width: 120 }}>
          <UnitToggle value={unit} onChange={setUnit} accessibilityLabel="Unit for this value" />
        </View>
      </Stack>

      {error ? (
        <Type variant="caption" tone="negative">
          {error}
        </Type>
      ) : (
        <Type variant="caption" tone="tertiary">
          Correcting the number does not move when it was taken.
        </Type>
      )}

      <Stack direction="row" gap={spacing.sm}>
        <Button label="Cancel" onPress={onCancel} variant="secondary" style={{ flex: 1 }} />
        <Button label="Save correction" onPress={save} style={{ flex: 2 }} />
      </Stack>

      <Divider />

      <Pressable
        onPress={confirmDelete}
        accessibilityRole="button"
        // Says what disappears, not just "delete" — the confirm dialog is the
        // last chance to notice this is the wrong row.
        accessibilityLabel={`Delete the ${pointLabel} measurement from ${when}`}
        hitSlop={8}
        style={{ minHeight: 44, justifyContent: 'center', alignItems: 'center' }}
      >
        <Type variant="caption" tone="negative">
          Delete this measurement
        </Type>
      </Pressable>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/**
 * Two-or-more-option segmented control.
 *
 * A segmented control rather than a switch: a switch has an implied on/off, and
 * neither centimetres nor inches is the "off" one.
 */
export function SegmentedChoice({
  value,
  options,
  onChange,
  accessibilityLabel,
}: {
  value: string;
  options: readonly { value: string; label: string; description: string }[];
  onChange: (next: string) => void;
  accessibilityLabel: string;
}): React.ReactElement {
  const theme = useTheme();

  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      style={{
        flexDirection: 'row',
        padding: spacing.xs,
        gap: spacing.xs,
        borderRadius: radius.md,
        backgroundColor: theme.color.surfaceRaised,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.color.border,
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            // The description carries the meaning so the control does not rely
            // on a two-letter abbreviation being read aloud sensibly.
            accessibilityLabel={option.description}
            style={{
              flex: 1,
              minHeight: 44,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radius.sm,
              backgroundColor: selected ? theme.color.accent : 'transparent',
            }}
          >
            <Type
              variant="bodyStrong"
              tone={selected ? 'default' : 'secondary'}
              style={selected ? { color: '#fff' } : undefined}
            >
              {option.label}
            </Type>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The length-unit flavour of `SegmentedChoice`, used by the entry screens. */
export function UnitToggle({
  value,
  onChange,
  accessibilityLabel,
}: {
  value: LengthUnit;
  onChange: (unit: LengthUnit) => void;
  accessibilityLabel: string;
}): React.ReactElement {
  return (
    <SegmentedChoice
      value={value}
      options={UNIT_OPTIONS}
      onChange={(next) => onChange(next as LengthUnit)}
      accessibilityLabel={accessibilityLabel}
    />
  );
}

// ---------------------------------------------------------------------------
// Body fat
// ---------------------------------------------------------------------------

/**
 * A body fat estimate, shown as the band it is.
 *
 * The band is the headline, at metric size, and the confidence sits next to it
 * rather than under a "details" tap. A number this soft has to carry its own
 * caveat or the caveat does not travel with it.
 *
 * There is deliberately no single figure anywhere in this component — not a
 * midpoint, not a "≈". The width of the band is the honest statement of how
 * much the method knows, and a midpoint would let the athlete quietly discard
 * it.
 */
export function BodyFatRange({ estimate }: { estimate: BodyFatEstimate }): React.ReactElement {
  const theme = useTheme();

  // Low confidence gets a caution tone rather than a neutral one: it is the
  // case where an athlete most needs to not read the band as a fact.
  const tone: 'positive' | 'neutral' | 'caution' =
    estimate.confidence === 'high'
      ? 'positive'
      : estimate.confidence === 'moderate'
        ? 'neutral'
        : 'caution';

  return (
    <Card>
      <Stack gap={spacing.lg}>
        <Stack gap={spacing.xs}>
          <Type
            variant="metricLarge"
            // One label for the whole reading: a screen reader should not have
            // to assemble "17.4", "to", "20.2" into a range itself.
            accessibilityRole="text"
          >
            {formatRange(estimate)}
          </Type>
          <Type variant="caption" tone="tertiary">
            A {rangeWidth(estimate).toFixed(1)} point band, not a single figure
          </Type>
        </Stack>

        <RangeBand low={estimate.valueLow} high={estimate.valueHigh} />

        <Stack direction="row" gap={spacing.sm} align="center" style={{ flexWrap: 'wrap' }}>
          <Chip label={CONFIDENCE_LABELS[estimate.confidence]} tone={tone} selected />
          {estimate.serviceStatus && estimate.serviceStatus !== 'active' ? (
            <Chip
              label={estimate.serviceStatus === 'failed' ? 'Service failed' : 'Service unavailable'}
              tone="negative"
              selected
            />
          ) : null}
        </Stack>

        <View
          style={{
            height: StyleSheet.hairlineWidth,
            backgroundColor: theme.color.border,
          }}
        />

        <Stack gap={spacing.xs}>
          <Type variant="overline" tone="tertiary" accessibilityRole="header">
            WHAT IT IS BASED ON
          </Type>
          <Type variant="body" tone="secondary">
            {estimate.basis}
          </Type>
        </Stack>
      </Stack>
    </Card>
  );
}

/**
 * The estimate drawn as a band on a fixed scale.
 *
 * A number in text is read as a number; a segment with visible width is read as
 * a range. That is the entire purpose of this component — it makes the
 * uncertainty something the athlete sees rather than something they have to
 * work out from two figures either side of a dash.
 *
 * **The scale carries no zones and no colour coding.** Marking off
 * "essential / athletic / average / high" is exactly the medical judgement the
 * notice underneath disclaims, and those thresholds vary by sex, age and the
 * method used to define them — none of which this estimate knows. A neutral
 * track with the athlete's own band on it says what is true and nothing more.
 */
export function RangeBand({ low, high }: { low: number; high: number }): React.ReactElement | null {
  const theme = useTheme();

  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;

  const { start, width } = bandGeometry(low, high);

  return (
    // Hidden from screen readers: the text above already states the range and
    // the confidence, and a second rendering of the same fact is noise.
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Stack gap={spacing.xs}>
        <View
          style={{
            height: 10,
            borderRadius: radius.pill,
            backgroundColor: theme.color.border,
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              position: 'absolute',
              left: `${start * 100}%`,
              width: `${width * 100}%`,
              height: '100%',
              borderRadius: radius.pill,
              backgroundColor: theme.color.accent,
            }}
          />
        </View>
        <Stack direction="row" justify="space-between">
          <Type variant="caption" tone="tertiary">
            {BODY_FAT_SCALE.min}%
          </Type>
          <Type variant="caption" tone="tertiary">
            {BODY_FAT_SCALE.max}%
          </Type>
        </Stack>
      </Stack>
    </View>
  );
}

/**
 * The non-medical notice.
 *
 * A component rather than a paragraph each screen writes for itself, so the
 * wording cannot drift and cannot quietly soften on the screen where it is
 * least convenient. Every surface that shows an estimate shows this.
 *
 * `compact` is for sitting directly under a result, where the heading would be
 * a third thing competing for attention; the sentence itself never shortens.
 */
export function NonMedicalNotice({ compact = false }: { compact?: boolean }): React.ReactElement {
  const body = (
    <Type variant={compact ? 'caption' : 'body'} tone="secondary">
      {NON_MEDICAL_NOTE}
    </Type>
  );

  if (compact) return body;

  return (
    <Card>
      <Stack gap={spacing.sm}>
        <Type variant="bodyStrong" tone="caution" accessibilityRole="header">
          What this number is
        </Type>
        {body}
      </Stack>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Formula inputs
// ---------------------------------------------------------------------------

/**
 * Pick which of the published equation's coefficient sets to apply.
 *
 * Framed as a choice between two equations, with what each one reads stated
 * next to it, rather than as a question about the athlete. That is what the
 * formula actually is, and it lets someone whose measurements do not sort
 * neatly into the reference populations choose the equation that fits what they
 * can measure.
 */
export function VariantPicker({
  value,
  onChange,
}: {
  value?: FormulaVariant;
  onChange: (variant: FormulaVariant) => void;
}): React.ReactElement {
  return (
    <Stack gap={spacing.md}>
      <Stack direction="row" gap={spacing.sm} style={{ flexWrap: 'wrap' }}>
        {FORMULA_VARIANTS.map((variant) => (
          <Chip
            key={variant}
            label={VARIANT_LABELS[variant]}
            selected={variant === value}
            tone={variant === value ? 'accent' : 'neutral'}
            onPress={() => onChange(variant)}
          />
        ))}
      </Stack>
      {value ? (
        <Type variant="caption" tone="secondary">
          {VARIANT_DESCRIPTIONS[value]}
        </Type>
      ) : null}
      <Type variant="caption" tone="tertiary">
        {VARIANT_NOTE}
      </Type>
    </Stack>
  );
}

/**
 * A labelled numeric field with the unit beside it.
 *
 * Shared by height and weight because they differ only in their unit and their
 * bounds; two near-identical blocks in the screen would drift.
 */
export function QuantityField({
  label,
  value,
  unit,
  onChangeText,
  onChangeUnit,
  unitOptions,
  hint,
  error,
}: {
  label: string;
  value: string;
  unit: string;
  onChangeText: (next: string) => void;
  onChangeUnit: (next: string) => void;
  unitOptions: readonly { value: string; label: string; description: string }[];
  hint?: string;
  error?: string;
}): React.ReactElement {
  const theme = useTheme();

  return (
    <Stack gap={spacing.sm}>
      <Type variant="overline" tone="tertiary" accessibilityRole="header">
        {label.toUpperCase()}
      </Type>
      <Stack direction="row" gap={spacing.sm} align="center">
        <TextInput
          value={value}
          onChangeText={onChangeText}
          keyboardType="decimal-pad"
          inputMode="decimal"
          placeholder="0.0"
          placeholderTextColor={theme.color.textTertiary}
          accessibilityLabel={`${label} in ${unit}`}
          returnKeyType="done"
          style={{
            flex: 1,
            minHeight: 48,
            paddingHorizontal: spacing.md,
            borderRadius: radius.md,
            backgroundColor: theme.color.surface,
            color: theme.color.text,
            borderWidth: 1,
            borderColor: error ? theme.color.negative : theme.color.border,
            fontVariant: ['tabular-nums' as const],
          }}
        />
        <View style={{ width: 108 }}>
          <SegmentedChoice
            value={unit}
            options={unitOptions}
            onChange={onChangeUnit}
            accessibilityLabel={`Unit for ${label.toLowerCase()}`}
          />
        </View>
      </Stack>
      {error ? (
        <Type variant="caption" tone="negative">
          {error}
        </Type>
      ) : hint ? (
        <Type variant="caption" tone="tertiary">
          {hint}
        </Type>
      ) : null}
    </Stack>
  );
}

/**
 * What the formula still needs.
 *
 * Every requirement is listed, met or not, so the athlete can see what the
 * calculation rests on rather than only what is blocking it. A checklist that
 * ticks over is also the clearest possible answer to "why is it asking me for
 * my height?".
 */
export function RequirementList({
  requirements,
}: {
  requirements: readonly Requirement[];
}): React.ReactElement {
  return (
    <Stack gap={spacing.md}>
      {requirements.map((requirement, index) => (
        <React.Fragment key={requirement.key}>
          {index > 0 ? <Divider /> : null}
          <View
            accessible
            accessibilityLabel={`${requirement.label}, ${
              requirement.satisfied ? 'ready' : 'still needed'
            }. ${requirement.detail}`}
          >
            <Stack direction="row" justify="space-between" align="center" gap={spacing.md}>
              <Stack gap={2} style={{ flexShrink: 1 }}>
                <Type variant="bodyStrong" tone={requirement.satisfied ? 'default' : 'secondary'}>
                  {requirement.label}
                </Type>
                <Type variant="caption" tone="tertiary">
                  {requirement.detail}
                </Type>
              </Stack>
              {/* A word, not only a tick: colour and glyph alone leave a
                  screen reader with nothing and a colour-blind reader with
                  two similar shapes. */}
              <Chip
                label={requirement.satisfied ? 'Ready' : 'Needed'}
                tone={requirement.satisfied ? 'positive' : 'caution'}
                selected
              />
            </Stack>
          </View>
        </React.Fragment>
      ))}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Formula result
// ---------------------------------------------------------------------------

/**
 * The formula's result with every step that produced it.
 *
 * The steps are the feature, not a debug aid. An estimate an athlete cannot
 * inspect is a number they have to take on trust, and this one does not deserve
 * that much: seeing it reduce to waist-minus-neck and two logarithms is exactly
 * what stops it being read as a body scan.
 *
 * They are shown expanded rather than behind a disclosure. Transparency that
 * requires a tap is transparency most people never see, and the whole argument
 * for showing a soft number at all is that its softness is visible.
 *
 * A failed calculation renders the same way: the steps completed before it
 * broke, and what stopped it. "Waist minus neck came out negative" locates the
 * problem in a way "could not calculate" never does.
 */
export function FormulaSteps({ estimate }: { estimate: NavyEstimate }): React.ReactElement {
  const theme = useTheme();

  return (
    <Card>
      <Stack gap={spacing.lg}>
        <Stack gap={spacing.xs}>
          <Type variant="overline" tone="tertiary" accessibilityRole="header">
            HOW THIS WAS CALCULATED
          </Type>
          <Type variant="caption" tone="tertiary">
            US Navy equation, metric form. Every measurement below is in centimetres.
          </Type>
        </Stack>

        <Stack gap={spacing.md}>
          {estimate.steps.map((step, index) => (
            <React.Fragment key={step.label}>
              {index > 0 ? <Divider /> : null}
              <View
                accessible
                accessibilityLabel={`Step ${index + 1}. ${step.label}. ${step.expression} equals ${step.value}${step.unit ? ` ${step.unit}` : ''}`}
              >
                <Stack gap={spacing.xs}>
                  <Stack direction="row" justify="space-between" align="center" gap={spacing.md}>
                    <Type variant="bodyStrong" style={{ flexShrink: 1 }}>
                      {step.label}
                    </Type>
                    <Type variant="metricSmall">
                      {step.value}
                      {step.unit ? ` ${step.unit}` : ''}
                    </Type>
                  </Stack>
                  {/* The arithmetic with the numbers filled in, so the reader
                      can follow it rather than trust it. */}
                  <Type variant="caption" tone="tertiary" style={{ fontVariant: ['tabular-nums'] }}>
                    {step.expression}
                  </Type>
                </Stack>
              </View>
            </React.Fragment>
          ))}
        </Stack>

        {estimate.ok ? (
          <View
            style={{
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: theme.color.border,
              paddingTop: spacing.md,
            }}
          >
            <Type variant="caption" tone="secondary">
              The band shown above is that figure plus and minus {estimate.standardError.toFixed(1)}{' '}
              points, which is roughly this method&apos;s published error against a laboratory
              measurement.
            </Type>
          </View>
        ) : (
          <View
            style={{
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: theme.color.border,
              paddingTop: spacing.md,
            }}
          >
            <Type variant="bodyStrong" tone="negative">
              Could not finish
            </Type>
            <Type variant="body" tone="secondary" style={{ marginTop: spacing.xs }}>
              {estimate.reason}
            </Type>
          </View>
        )}
      </Stack>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Photo service status
// ---------------------------------------------------------------------------

/**
 * What the photo method can do right now, and the way forward when it cannot.
 *
 * Status on its own is an announcement; status with a route out is help. Every
 * branch that cannot produce a result offers the measurements method, because
 * that one needs no server and no network — it is the path that always works,
 * and an athlete told only that something is broken has been handed a dead end.
 *
 * Tone follows severity rather than decorating it: a service outage is not the
 * athlete's fault and does not warrant an alarm, but it does warrant being
 * unmissable, so the state is always spelled out in words as well.
 */
export function ServiceStatusNotice({
  message,
  onSwitchToFormula,
  onTakePhotos,
}: {
  message: AvailabilityMessage;
  onSwitchToFormula: () => void;
  onTakePhotos: () => void;
}): React.ReactElement {
  const tone =
    message.availability === 'ready'
      ? 'positive'
      : message.availability === 'failed'
        ? 'negative'
        : 'caution';

  return (
    <Card>
      <Stack gap={spacing.md}>
        <Stack direction="row" justify="space-between" align="center" gap={spacing.md}>
          <Type variant="bodyStrong" style={{ flexShrink: 1 }} accessibilityRole="header">
            {message.title}
          </Type>
          {/* The state in words, not only in colour: a status conveyed by hue
              alone reaches neither a screen reader nor a colour-blind eye. */}
          <Chip
            label={
              message.availability === 'ready'
                ? 'Running'
                : message.availability === 'no_photos'
                  ? 'No photos'
                  : message.availability === 'failed'
                    ? 'Failed'
                    : 'Unavailable'
            }
            tone={tone}
            selected
          />
        </Stack>

        <Type variant="body" tone="secondary">
          {message.body}
        </Type>

        {message.action === 'switch_to_formula' ? (
          <Button label="Use the measurements method" onPress={onSwitchToFormula} />
        ) : message.action === 'take_photos' ? (
          <Button label="Take session photos" onPress={onTakePhotos} variant="secondary" />
        ) : null}
      </Stack>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Photo comparison
// ---------------------------------------------------------------------------

/**
 * The same four views, twice, before against after.
 *
 * Paired by side and stacked one row per side, rather than two grids of four.
 * The comparison an athlete is making is front-to-front; putting the two fronts
 * anywhere but next to each other asks them to hold one in their head while
 * they look at the other, which is exactly the job a before-and-after layout
 * exists to remove.
 *
 * All four sides are shown whether or not both photos exist. A layout that
 * quietly dropped the sides it could not pair would make a half-photographed
 * session look complete.
 */
export function PhotoComparison({
  pairs,
  earlierLabel,
  laterLabel,
}: {
  pairs: readonly PhotoPair[];
  earlierLabel: string;
  laterLabel: string;
}): React.ReactElement {
  return (
    <Card>
      <Stack gap={spacing.lg}>
        <Stack direction="row" gap={spacing.md}>
          <Type variant="overline" tone="tertiary" style={{ flex: 1 }} accessibilityRole="header">
            {earlierLabel.toUpperCase()}
          </Type>
          <Type variant="overline" tone="tertiary" style={{ flex: 1 }} accessibilityRole="header">
            {laterLabel.toUpperCase()}
          </Type>
        </Stack>

        {pairs.map((pair, index) => (
          <React.Fragment key={pair.side}>
            {index > 0 ? <Divider /> : null}
            <Stack gap={spacing.sm}>
              <Stack direction="row" justify="space-between" align="center">
                <Type variant="bodyStrong">{SIDE_LABELS[pair.side]}</Type>
                {!pair.comparable ? <Chip label="Only one side" tone="caution" selected /> : null}
              </Stack>
              <Stack direction="row" gap={spacing.md}>
                <PhotoSlot photo={pair.earlier} side={SIDE_LABELS[pair.side]} when={earlierLabel} />
                <PhotoSlot photo={pair.later} side={SIDE_LABELS[pair.side]} when={laterLabel} />
              </Stack>
            </Stack>
          </React.Fragment>
        ))}
      </Stack>
    </Card>
  );
}

/**
 * One photo, or an honest statement of why there is not one.
 *
 * Two different absences, told apart: the session never had this side, or it
 * has it and the bytes are not reachable from here. Rendering both as an empty
 * box would leave an athlete wondering whether their photo had been lost.
 */
function PhotoSlot({
  photo,
  side,
  when,
}: {
  photo?: CompositionPhoto;
  side: string;
  when: string;
}): React.ReactElement {
  const theme = useTheme();

  const frame = {
    flex: 1,
    aspectRatio: 3 / 4,
    borderRadius: radius.md,
    backgroundColor: theme.color.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    overflow: 'hidden' as const,
    padding: spacing.sm,
  };

  if (photo?.uri) {
    return (
      <Image
        source={{ uri: photo.uri }}
        style={frame}
        resizeMode="cover"
        accessible
        accessibilityLabel={`${side} photo from ${when}`}
      />
    );
  }

  return (
    <View
      style={frame}
      accessible
      accessibilityLabel={
        photo
          ? `${side} photo from ${when}, not available in this preview`
          : `No ${side.toLowerCase()} photo in the ${when} session`
      }
    >
      <Type variant="caption" tone="tertiary" style={{ textAlign: 'center' }}>
        {photo ? `${side}\n(not loaded here)` : `No ${side.toLowerCase()} photo`}
      </Type>
    </View>
  );
}
