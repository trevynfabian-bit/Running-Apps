/**
 * Record body circumference.
 *
 * The screen exists to make one thing effortless: an athlete who measures in
 * inches should never have to say so twice. Their default unit is stored once
 * and every subsequent entry opens in it — after a save, after leaving the
 * screen, after restarting the app.
 *
 * Work in progress is held per measure point. Someone measuring their waist who
 * jumps to the chest and back finds the waist number still there, and finds the
 * chest field empty rather than pre-filled with the waist's. The unit travels
 * with each draft, so a number typed in inches is never re-read as centimetres
 * because another point was visited in between.
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
 * Saved values go into the active session — one documentation moment holding
 * at most one value per point — rather than into a flat list local to this
 * screen. That is what a later session gets compared against, and it is why
 * re-measuring a point replaces its value instead of adding a second one.
 *
 * Data is stubbed: this is the UI half of the feature, built against the
 * contract in the PRD. Nothing here talks to the API yet.
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { router } from 'expo-router';

import { formatCanonicalLength, parseLength, toCanonicalLength } from '@running/core';

import { STUB_CIRCUMFERENCE_POINTS, findPoint } from '../../src/lib/body-composition';
import { useCompositionSessions } from '../../src/lib/composition-session-store';
import {
  MetricHistoryCard,
  PrivacyLink,
  SessionSummaryCard,
  UnitToggle,
} from '../../src/components/composition';
import { historyForPoint } from '../../src/lib/composition-history';
import { useMeasurementUnit } from '../../src/lib/measurement-units';
import {
  clearDraft,
  readDraft,
  startedPointIds,
  writeDraft,
  type DraftsByPoint,
  type MeasurementDraft,
} from '../../src/lib/measurement-draft';
import { radius, spacing } from '../../src/design/tokens';
import { useTheme } from '../../src/design/theme';
import {
  Button,
  Card,
  Chip,
  Divider,
  LoadingState,
  Screen,
  SectionHeader,
  Stack,
  Type,
} from '../../src/components/primitives';

export default function MeasurementsScreen(): React.ReactElement {
  const theme = useTheme();
  const { defaultUnit, ready, setDefaultUnit } = useMeasurementUnit();

  const {
    active: session,
    all: sessions,
    record,
    amend,
    remove,
    recorded,
  } = useCompositionSessions();

  const [pointId, setPointId] = useState(STUB_CIRCUMFERENCE_POINTS[0]!.id);
  const [drafts, setDrafts] = useState<DraftsByPoint>({});
  const [error, setError] = useState<string>();

  /**
   * What is in the form right now: this point's draft, not a shared buffer.
   *
   * A draft's `unit` is `undefined` in the normal case, meaning "whatever the
   * default is". That is what lets a changed default reach every draft that
   * never overrode it, without anything copying the value across.
   */
  const draft = readDraft(drafts, pointId);
  const value = draft.value;

  /**
   * An override that matches the default is not an override.
   *
   * It can end up stored that way: pick inches for one entry, then change the
   * default to inches as well, and the entry is no longer deviating from
   * anything. Collapsing it here keeps the copy honest — otherwise the form
   * would offer to make inches the default when inches already is.
   */
  const override = draft.unit === defaultUnit ? undefined : draft.unit;
  const entryUnit = override ?? defaultUnit;

  const point = findPoint(pointId);

  const patchDraft = (patch: Partial<MeasurementDraft>): void =>
    setDrafts((current) => writeDraft(current, pointId, patch));

  /**
   * Switch points, carrying nothing across.
   *
   * The error is dropped rather than moved: it describes an attempt to save
   * *this* point, and showing it over another point's empty field would be
   * telling the athlete about a problem they are not looking at.
   */
  const selectPoint = (nextPointId: string): void => {
    setPointId(nextPointId);
    setError(undefined);
  };

  /**
   * Other points the athlete has started but not saved.
   *
   * Listed in the picker's own order rather than the order they were typed, so
   * the names read down the body the same way the chips above them do.
   */
  /** What this session already holds for the point on screen, if anything. */
  const alreadyRecorded = recorded(pointId);

  /**
   * This point's values over time, with the in-progress session at the front
   * when it has one. Including it means a measurement just saved lands in the
   * history immediately instead of appearing only after the session is filed.
   */
  const history = historyForPoint(sessions, pointId);

  const inProgress = STUB_CIRCUMFERENCE_POINTS.filter(
    (option) =>
      option.id !== pointId &&
      startedPointIds(drafts).includes(option.id) &&
      readDraft(drafts, option.id).value.trim() !== '',
  ).map((option) => option.label);

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

    // Into the active session, which starts on this first record if there
    // isn't one yet. Measuring a point twice replaces its value rather than
    // leaving the session holding two answers for one question.
    record({
      pointId,
      valueCm: toCanonicalLength(parsed, entryUnit),
      recordedUnit: entryUnit,
      capturedAt: new Date().toISOString(),
    });

    setError(undefined);
    // Drop this point's draft entirely — value and unit. The next entry on it
    // starts empty and back on the stored default; a one-off unit stays a
    // one-off. Drafts on other points are untouched.
    setDrafts((current) => clearDraft(current, pointId));
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
                      onPress={() => selectPoint(option.id)}
                    />
                  ))}
                </Stack>
                {point ? (
                  <Type variant="caption" tone="secondary">
                    {point.guideText}
                  </Type>
                ) : null}
                {inProgress.length > 0 ? (
                  <Type variant="caption" tone="tertiary">
                    Still unsaved on {inProgress.join(', ')} — switching back keeps what you typed.
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
                      patchDraft({ value: next });
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
                  onChange={(next) => patchDraft({ unit: next === defaultUnit ? undefined : next })}
                  accessibilityLabel="Unit for this entry"
                />
                {override ? (
                  <Pressable
                    onPress={() => {
                      setDefaultUnit(override);
                      patchDraft({ unit: undefined });
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

              {alreadyRecorded ? (
                <Type variant="caption" tone="caution">
                  {point?.label ?? 'This point'} is already in this session at{' '}
                  {formatCanonicalLength(alreadyRecorded.valueCm, defaultUnit)}. Saving replaces it.
                </Type>
              ) : null}

              <Button
                label={alreadyRecorded ? 'Replace measurement' : 'Save measurement'}
                onPress={save}
              />
            </Stack>
          </Card>
        </View>

        <View>
          <SectionHeader title="Session summary" />
          <SessionSummaryCard
            session={session}
            points={STUB_CIRCUMFERENCE_POINTS}
            displayUnit={defaultUnit}
            highlightPointId={pointId}
          />
        </View>

        <View>
          <SectionHeader title={`${point?.label ?? 'Measure point'} over time`} />
          <MetricHistoryCard
            pointLabel={point?.label ?? 'this point'}
            entries={history}
            displayUnit={defaultUnit}
            onCorrect={(sessionId, correction) => amend(sessionId, pointId, correction)}
            onDelete={(sessionId) => remove(sessionId, pointId)}
          />
        </View>
        <PrivacyLink onPress={() => router.push('/composition/privacy')} />
      </Stack>
    </Screen>
  );
}
