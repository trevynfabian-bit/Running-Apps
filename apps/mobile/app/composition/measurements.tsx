/**
 * Record body circumference.
 *
 * The screen exists to make one thing effortless: an athlete who measures in
 * inches should never have to say so twice. Their default unit is stored once
 * and every subsequent entry opens in it — after a save, after leaving the
 * screen, after restarting the app.
 *
 * A per-entry override sits next to the input for the case where one number was
 * read off a differently marked tape. That override is deliberately scoped to
 * the entry being typed: saving resets the form to the stored default rather
 * than letting a one-off choice silently become the new normal. Promoting an
 * override to the default is a separate, explicit tap.
 *
 * Saved values are kept in centimetres and re-displayed in the unit they were
 * measured in, so changing the default never rewrites what an earlier session
 * recorded.
 *
 * Data is stubbed: this is the UI half of the feature, built against the
 * contract in the PRD. Nothing here talks to the API yet.
 */

import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import {
  formatCanonicalLength,
  parseLength,
  toCanonicalLength,
  type LengthUnit,
} from '@running/core';

import {
  STUB_CIRCUMFERENCE_POINTS,
  findPoint,
  type BodyMeasurement,
} from '../../src/lib/body-composition';
import { UNIT_OPTIONS, useMeasurementUnit } from '../../src/lib/measurement-units';
import { radius, spacing } from '../../src/design/tokens';
import { useTheme } from '../../src/design/theme';
import {
  Button,
  Card,
  Chip,
  Divider,
  EmptyState,
  LoadingState,
  Screen,
  SectionHeader,
  Stack,
  Type,
} from '../../src/components/primitives';

export default function MeasurementsScreen(): React.ReactElement {
  const theme = useTheme();
  const { defaultUnit, ready, setDefaultUnit } = useMeasurementUnit();

  const [pointId, setPointId] = useState(STUB_CIRCUMFERENCE_POINTS[0]!.id);
  const [value, setValue] = useState('');
  const [entries, setEntries] = useState<BodyMeasurement[]>([]);
  const [error, setError] = useState<string>();

  /**
   * The unit this one entry is being typed in.
   *
   * `undefined` means "whatever the default is" — the normal case, and the
   * reason the default reaches the next entry without anything copying it
   * across. Only an explicit override puts a value here, and saving clears it.
   */
  const [rawOverride, setOverride] = useState<LengthUnit>();

  /**
   * An override that matches the default is not an override.
   *
   * It can end up stored that way: pick inches for one entry, then change the
   * default to inches as well, and the entry is no longer deviating from
   * anything. Collapsing it here keeps the copy honest — otherwise the form
   * would offer to make inches the default when inches already is.
   */
  const override = rawOverride === defaultUnit ? undefined : rawOverride;
  const entryUnit = override ?? defaultUnit;

  const point = findPoint(pointId);

  // Waiting avoids a flash of `cm` in front of an athlete who chose inches.
  if (!ready) return <LoadingState label="Loading your measurement setup" />;

  const field = {
    flex: 1,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: theme.color.surface,
    color: theme.color.text,
    borderWidth: 1,
    borderColor: theme.color.border,
    fontVariant: ['tabular-nums' as const],
  };

  const save = (): void => {
    const parsed = parseLength(value);
    if (parsed === undefined) {
      setError('Enter a measurement as a number, for example 86.4.');
      return;
    }

    setEntries((current) => [
      {
        id: `local-${Date.now()}`,
        pointId,
        valueCm: toCanonicalLength(parsed, entryUnit),
        recordedUnit: entryUnit,
        capturedAt: new Date().toISOString(),
      },
      ...current,
    ]);

    setValue('');
    setError(undefined);
    // Drop the override so the next entry starts from the stored default
    // again. A one-off unit stays a one-off.
    setOverride(undefined);
  };

  return (
    <Screen>
      <Stack gap={spacing.xl}>
        <Card>
          <Stack gap={spacing.md}>
            <Type variant="heading" accessibilityRole="header">
              Default unit
            </Type>
            <Type variant="body" tone="secondary">
              Every new entry opens in this unit, on this screen and the next time you open the app.
            </Type>
            <UnitToggle
              value={defaultUnit}
              onChange={setDefaultUnit}
              accessibilityLabel="Default measurement unit"
            />
            <Type variant="caption" tone="tertiary">
              Measurements you have already saved keep the unit they were taken in.
            </Type>
          </Stack>
        </Card>

        <View>
          <SectionHeader title="New measurement" />
          <Card>
            <Stack gap={spacing.lg}>
              <Stack gap={spacing.sm}>
                <Type variant="overline" tone="tertiary" accessibilityRole="header">
                  MEASURE POINT
                </Type>
                <Stack direction="row" gap={spacing.sm} style={{ flexWrap: 'wrap' }}>
                  {STUB_CIRCUMFERENCE_POINTS.map((option) => (
                    <Chip
                      key={option.id}
                      label={option.label}
                      selected={option.id === pointId}
                      tone={option.id === pointId ? 'accent' : 'neutral'}
                      onPress={() => setPointId(option.id)}
                    />
                  ))}
                </Stack>
                {point ? (
                  <Type variant="caption" tone="secondary">
                    {point.guideText}
                  </Type>
                ) : null}
              </Stack>

              <Divider />

              <Stack gap={spacing.sm}>
                <Type variant="overline" tone="tertiary" accessibilityRole="header">
                  VALUE
                </Type>
                <Stack direction="row" gap={spacing.sm} align="center">
                  <TextInput
                    value={value}
                    onChangeText={(next) => {
                      setValue(next);
                      if (error) setError(undefined);
                    }}
                    keyboardType="decimal-pad"
                    inputMode="decimal"
                    placeholder="0.0"
                    placeholderTextColor={theme.color.textTertiary}
                    style={field}
                    accessibilityLabel={`${point?.label ?? 'Measurement'} in ${entryUnit}`}
                    returnKeyType="done"
                    onSubmitEditing={save}
                  />
                  <View
                    style={{
                      minHeight: 48,
                      paddingHorizontal: spacing.md,
                      justifyContent: 'center',
                      borderRadius: radius.md,
                      backgroundColor: theme.color.surfaceRaised,
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: theme.color.border,
                    }}
                  >
                    <Type variant="bodyStrong" tone="secondary">
                      {entryUnit}
                    </Type>
                  </View>
                </Stack>

                {error ? (
                  <Type variant="caption" tone="negative">
                    {error}
                  </Type>
                ) : (
                  <Type variant="caption" tone="tertiary">
                    {override
                      ? `Using ${entryUnit} for this entry only. The next one returns to ${defaultUnit}.`
                      : `Using your default unit, ${defaultUnit}.`}
                  </Type>
                )}
              </Stack>

              <Stack gap={spacing.sm}>
                <Type variant="overline" tone="tertiary" accessibilityRole="header">
                  UNIT FOR THIS ENTRY
                </Type>
                <UnitToggle
                  value={entryUnit}
                  onChange={(next) => setOverride(next === defaultUnit ? undefined : next)}
                  accessibilityLabel="Unit for this entry"
                />
                {override ? (
                  <Pressable
                    onPress={() => {
                      setDefaultUnit(override);
                      setOverride(undefined);
                    }}
                    accessibilityRole="button"
                    hitSlop={8}
                    style={{ minHeight: 44, justifyContent: 'center' }}
                  >
                    <Type variant="caption" tone="accent">
                      Make {override} my default unit
                    </Type>
                  </Pressable>
                ) : null}
              </Stack>

              <Button label="Save measurement" onPress={save} />
            </Stack>
          </Card>
        </View>

        <View>
          <SectionHeader title="Recorded this session" />
          {entries.length === 0 ? (
            <EmptyState
              title="Nothing recorded yet"
              body="Pick a measure point, enter the number from the tape, and save it."
            />
          ) : (
            <Card>
              <Stack gap={spacing.md}>
                {entries.map((entry, index) => (
                  <React.Fragment key={entry.id}>
                    {index > 0 ? <Divider /> : null}
                    <EntryRow entry={entry} displayUnit={defaultUnit} />
                  </React.Fragment>
                ))}
              </Stack>
            </Card>
          )}
        </View>
      </Stack>
    </Screen>
  );
}

/**
 * Segmented unit control.
 *
 * A two-option segmented control rather than a switch: a switch has an implied
 * on/off, and neither centimetres nor inches is the "off" one.
 */
function UnitToggle({
  value,
  onChange,
  accessibilityLabel,
}: {
  value: LengthUnit;
  onChange: (unit: LengthUnit) => void;
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
      {UNIT_OPTIONS.map((option) => {
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

/**
 * One saved measurement.
 *
 * Shown in the athlete's current default unit, with the original noted when the
 * two differ. Hiding that would make a set of entries look inconsistent for no
 * visible reason the first time someone switches their default.
 */
function EntryRow({
  entry,
  displayUnit,
}: {
  entry: BodyMeasurement;
  displayUnit: LengthUnit;
}): React.ReactElement {
  const point = findPoint(entry.pointId);
  const converted = entry.recordedUnit !== displayUnit;

  const capturedAt = useMemo(
    () =>
      new Date(entry.capturedAt).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      }),
    [entry.capturedAt],
  );

  return (
    <Stack direction="row" justify="space-between" align="center" gap={spacing.md}>
      <Stack gap={2} style={{ flexShrink: 1 }}>
        <Type variant="bodyStrong">{point?.label ?? 'Measurement'}</Type>
        <Type variant="caption" tone="tertiary">
          {converted
            ? `${capturedAt} · recorded as ${formatCanonicalLength(
                entry.valueCm,
                entry.recordedUnit,
              )}`
            : capturedAt}
        </Type>
      </Stack>
      <Type variant="metricSmall">{formatCanonicalLength(entry.valueCm, displayUnit)}</Type>
    </Stack>
  );
}
