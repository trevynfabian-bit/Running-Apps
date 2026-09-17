/**
 * Body composition capture components.
 *
 * The tile is the recurring unit: one body angle, either photographed or still
 * outstanding. It appears at capture size while the athlete is shooting and at
 * thumbnail size on the review grid, and it looks the same in both places so
 * the review reads as the same four things they just took.
 *
 * An outstanding side is drawn as a labelled dashed slot rather than left
 * blank. A gap the athlete cannot name is a gap they cannot fill.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  COMPOSITION_SIDES,
  COMPOSITION_SIDE_LABELS,
  captureProgress,
  missingSides,
  fromCentimetres,
  validateSessionDraft,
  type CompositionSide,
  type CompositionPhotoDraft,
  type CompositionSessionDraft,
  type BodyMeasurementDraft,
  type CircumferencePointCode,
  type MeasurementUnit,
  type SessionDraftProblem,
} from '@running/core';

import { radius, spacing } from '../design/tokens';
import { typeStyle, useTheme } from '../design/theme';
import { Button, Card, Stack, Type } from './primitives';
import { isStubPhotoUri, stubCaptureMethod } from '../lib/composition-capture';
import { SESSION_SETUP, SIDE_GUIDANCE } from '../lib/composition-guidance';
import {
  TAPE_GUIDANCE,
  UNIT_LABELS,
  formatMeasurement,
  parseMeasurementInput,
} from '../lib/composition-measurement';

/** Portrait. A standing body fits this far better than a square crop. */
const ASPECT_RATIO = 3 / 4;

export function SidePhotoTile({
  side,
  photo,
  onPress,
  caption,
  action,
}: {
  side: CompositionSide;
  photo?: CompositionPhotoDraft;
  onPress?: () => void;
  caption?: string;
  /**
   * An action for this angle alone, shown under the caption.
   *
   * A nested pressable, which React Native resolves to the inner one, so the
   * action fires without also triggering whatever tapping the tile does.
   */
  action?: { label: string; onPress: () => void };
}): React.ReactElement {
  const theme = useTheme();
  const label = COMPOSITION_SIDE_LABELS[side];

  const frame = {
    aspectRatio: ASPECT_RATIO,
    borderRadius: radius.md,
    overflow: 'hidden' as const,
    backgroundColor: theme.color.surfaceRaised,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    borderWidth: photo ? StyleSheet.hairlineWidth : 1,
    borderColor: photo ? theme.color.border : theme.color.borderStrong,
    // A dashed edge reads as "nothing here yet" without needing a caption to
    // say so.
    borderStyle: photo ? ('solid' as const) : ('dashed' as const),
  };

  return (
    <Card
      onPress={onPress}
      // Deliberately states only what is there. The tile opens a preview on the
      // review and switches angle during capture, so naming an action here
      // would be wrong in one of the two places.
      accessibilityLabel={photo ? `${label}, photographed` : `${label}, not photographed yet`}
      style={{ padding: spacing.sm, flex: 1 }}
    >
      <Stack gap={spacing.sm}>
        <View style={frame}>
          {photo ? <PhotoFill photo={photo} label={label} /> : <EmptySlot />}
        </View>

        <Stack gap={1}>
          <Type variant="caption" tone={photo ? 'default' : 'tertiary'}>
            {label}
          </Type>
          {caption ? (
            <Type variant="caption" tone="tertiary" numberOfLines={1}>
              {caption}
            </Type>
          ) : null}
        </Stack>

        {action ? (
          <Pressable
            onPress={action.onPress}
            accessibilityRole="button"
            accessibilityLabel={`${action.label} the ${label.toLowerCase()} photo`}
            hitSlop={8}
            style={({ pressed }) => ({
              minHeight: 32,
              justifyContent: 'center',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Type variant="caption" tone="accent">
              {action.label}
            </Type>
          </Pressable>
        ) : null}
      </Stack>
    </Card>
  );
}

/**
 * The image itself, or a stand-in when the URI came from the capture stub.
 *
 * Handing a stub URI to `Image` would render an empty box that looks like a
 * loading failure, so the stub is drawn explicitly and labelled as a sample.
 */
function PhotoFill({
  photo,
  label,
}: {
  photo: CompositionPhotoDraft;
  label: string;
}): React.ReactElement {
  const theme = useTheme();

  if (!isStubPhotoUri(photo.uri)) {
    return (
      <Image
        source={{ uri: photo.uri }}
        style={{ width: '100%', height: '100%' }}
        resizeMode="cover"
        accessibilityIgnoresInvertColors
      />
    );
  }

  const method = stubCaptureMethod(photo.uri);

  return (
    <View
      style={{
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.xs,
        backgroundColor: theme.color.surfaceRaised,
      }}
    >
      <Type variant="heading" tone="secondary">
        {label}
      </Type>
      <Type variant="caption" tone="tertiary">
        Sample{method ? ` · ${method}` : ''}
      </Type>
    </View>
  );
}

function EmptySlot(): React.ReactElement {
  return (
    <Type variant="metricMedium" tone="tertiary">
      +
    </Type>
  );
}

/**
 * How far through the four angles the athlete is.
 *
 * Both a count and dots: the count is what a screen reader announces, the dots
 * are what the eye picks up without reading.
 */
export function CaptureProgress({
  captured,
  total,
  sides,
  capturedSides,
}: {
  captured: number;
  total: number;
  sides: readonly CompositionSide[];
  capturedSides: readonly CompositionSide[];
}): React.ReactElement {
  const theme = useTheme();

  return (
    <Stack direction="row" gap={spacing.md} align="center">
      <Type variant="caption" tone="secondary">
        {captured} of {total} angles
      </Type>
      <Stack direction="row" gap={spacing.xs} align="center" style={{ flex: 1 }}>
        {sides.map((side) => (
          <View
            key={side}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              backgroundColor: capturedSides.includes(side)
                ? theme.color.accent
                : theme.color.border,
            }}
          />
        ))}
      </Stack>
    </Stack>
  );
}

/**
 * The setup checklist, shown before the first angle.
 *
 * Numbered rather than bulleted: these are done in order, and the athlete is
 * working through them with a phone propped against something.
 */
export function SessionSetupGuide(): React.ReactElement {
  const theme = useTheme();

  return (
    <Card>
      <Stack gap={spacing.lg}>
        {SESSION_SETUP.map((item, index) => (
          <Stack key={item.title} direction="row" gap={spacing.md}>
            <View
              style={{
                width: 22,
                height: 22,
                borderRadius: radius.pill,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.color.borderStrong,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Type variant="caption" tone="secondary">
                {index + 1}
              </Type>
            </View>
            <Stack gap={2} style={{ flex: 1 }}>
              <Type variant="bodyStrong">{item.title}</Type>
              <Type variant="caption" tone="secondary">
                {item.detail}
              </Type>
            </Stack>
          </Stack>
        ))}
      </Stack>
    </Card>
  );
}

/**
 * Stance and framing for one angle.
 *
 * `compact` drops the heading for use on the capture screen, where the angle is
 * already the screen's title and repeating it pushes the viewfinder down.
 */
export function SideGuidanceCard({
  side,
  compact = false,
}: {
  side: CompositionSide;
  compact?: boolean;
}): React.ReactElement {
  const guidance = SIDE_GUIDANCE[side];

  return (
    <Card>
      <Stack gap={spacing.sm}>
        {compact ? null : <Type variant="bodyStrong">{COMPOSITION_SIDE_LABELS[side]}</Type>}
        <Stack gap={spacing.xs}>
          <Type variant="caption" tone="secondary">
            {guidance.stance}
          </Type>
          <Type variant="caption" tone="secondary">
            {guidance.framing}
          </Type>
        </Stack>
      </Stack>
    </Card>
  );
}

/**
 * When and how an angle was taken, for the tile caption and the preview.
 *
 * Time of day rather than a date: within a session all four are minutes apart,
 * and a gap between them is the useful signal — it usually means one angle was
 * redone later, under different light.
 */
export function describeCapture(photo: CompositionPhotoDraft): string {
  const method = stubCaptureMethod(photo.uri);
  const time = formatTimeOfDay(photo.capturedAt);
  return method ? `${time} · ${method}` : time;
}

function formatTimeOfDay(at: Date): string {
  const hours = String(at.getHours()).padStart(2, '0');
  const minutes = String(at.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * One angle at full size.
 *
 * The review grid is for spotting which angle is wrong; this is for deciding
 * whether it actually is. At thumbnail size a soft or badly framed shot looks
 * fine, and the athlete finds out weeks later when the comparison is useless.
 *
 * Stepping between angles is left and right through all four, not just the
 * taken ones: arriving at an empty angle and being offered the camera is a
 * reasonable way to finish a session.
 */
export function SidePhotoPreview({
  side,
  photo,
  visible,
  onClose,
  onRetake,
  onStep,
}: {
  side: CompositionSide;
  photo?: CompositionPhotoDraft;
  visible: boolean;
  onClose: () => void;
  onRetake: () => void;
  onStep: (delta: -1 | 1) => void;
}): React.ReactElement {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const index = COMPOSITION_SIDES.indexOf(side);

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      <View
        style={{
          flex: 1,
          backgroundColor: theme.color.background,
          paddingTop: insets.top + spacing.lg,
          paddingBottom: insets.bottom + spacing.lg,
          paddingHorizontal: spacing.lg,
          gap: spacing.lg,
        }}
      >
        <Stack direction="row" justify="space-between" align="center">
          <Stack gap={2}>
            <Type variant="heading">{COMPOSITION_SIDE_LABELS[side]}</Type>
            <Type variant="caption" tone="tertiary">
              {photo ? describeCapture(photo) : 'Not taken yet'}
            </Type>
          </Stack>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close preview"
            hitSlop={12}
            style={{
              minHeight: 44,
              minWidth: 44,
              alignItems: 'flex-end',
              justifyContent: 'center',
            }}
          >
            <Type variant="bodyStrong" tone="accent">
              Close
            </Type>
          </Pressable>
        </Stack>

        <View
          style={{
            flex: 1,
            borderRadius: radius.lg,
            overflow: 'hidden',
            backgroundColor: theme.color.surface,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.color.border,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {photo ? (
            <PhotoFill photo={photo} label={COMPOSITION_SIDE_LABELS[side]} />
          ) : (
            <Type variant="body" tone="tertiary">
              Nothing here yet
            </Type>
          )}
        </View>

        <Stack direction="row" justify="space-between" align="center">
          <PreviewStep
            label="Previous"
            glyph="‹"
            disabled={index <= 0}
            onPress={() => onStep(-1)}
          />
          <Type variant="caption" tone="tertiary">
            {index + 1} of {COMPOSITION_SIDES.length}
          </Type>
          <PreviewStep
            label="Next"
            glyph="›"
            disabled={index >= COMPOSITION_SIDES.length - 1}
            onPress={() => onStep(1)}
          />
        </Stack>

        <Button label={photo ? 'Retake this angle' : 'Take this angle'} onPress={onRetake} />
      </View>
    </Modal>
  );
}

function PreviewStep({
  label,
  glyph,
  disabled,
  onPress,
}: {
  label: string;
  glyph: string;
  disabled: boolean;
  onPress: () => void;
}): React.ReactElement {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      hitSlop={12}
      style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}
    >
      <Type variant="title" style={{ color: disabled ? theme.color.border : theme.color.accent }}>
        {glyph}
      </Type>
    </Pressable>
  );
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** "17 September 2026". Used by the review summary and the history list. */
export function describeSessionDate(at: Date): string {
  return `${at.getDate()} ${MONTHS[at.getMonth()] ?? ''} ${at.getFullYear()}`;
}

/** "Back", "Back and Right side", "Back, Left side and Right side". */
function listSides(sides: readonly CompositionSide[]): string {
  const labels = sides.map((side) => COMPOSITION_SIDE_LABELS[side]);
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * What this session holds, stated rather than left to be counted.
 *
 * The grid below it shows which angles are there; this says what that adds up
 * to. What is still outstanding is named by `SaveBlockers`, next to the button
 * it is blocking, rather than said twice.
 *
 * The time span is here because it is the one thing the photos cannot show. Four
 * angles taken minutes apart are one session; four taken hours apart are four
 * different sets of light, and that is worth noticing before saving them as a
 * single point of comparison.
 */
export function ReviewSummary({ draft }: { draft: CompositionSessionDraft }): React.ReactElement {
  const progress = captureProgress(draft);
  const complete = missingSides(draft).length === 0;

  const times = draft.photos.map((photo) => photo.capturedAt.getTime());
  const first = times.length > 0 ? Math.min(...times) : undefined;
  const last = times.length > 0 ? Math.max(...times) : undefined;
  const spansTime = first !== undefined && last !== undefined && last - first >= 60_000;

  return (
    <Card>
      <Stack gap={spacing.sm}>
        <Type variant="overline" tone="tertiary">
          SESSION · {describeSessionDate(draft.startedAt).toUpperCase()}
        </Type>

        <Type variant="bodyStrong" tone={complete ? 'default' : 'caution'}>
          {progress.captured} of {progress.total} angles
        </Type>

        {spansTime && first !== undefined && last !== undefined ? (
          <Type variant="caption" tone="tertiary">
            Taken between {formatTimeOfDay(new Date(first))} and {formatTimeOfDay(new Date(last))}.
            Angles taken well apart catch different light.
          </Type>
        ) : null}
      </Stack>
    </Card>
  );
}

/**
 * What is standing between this draft and a saved session.
 *
 * Renders nothing when the draft validates, so the review reads clean the
 * moment it is ready. Every problem is listed rather than only the first: a
 * disabled Save button with one reason under it invites the athlete to fix that
 * reason and find the button still disabled.
 *
 * The wording lives here because `@running/core` reports problem codes and has
 * no business holding sentences.
 */
export function SaveBlockers({
  draft,
}: {
  draft: CompositionSessionDraft;
}): React.ReactElement | null {
  const problems = validateSessionDraft(draft);
  if (problems.length === 0) return null;

  return (
    <Card>
      <Stack gap={spacing.sm}>
        <Type variant="bodyStrong" tone="caution">
          Not ready to save yet
        </Type>
        {problems.map((problem) => (
          <Type key={problemKey(problem)} variant="caption" tone="secondary">
            {describeProblem(problem)}
          </Type>
        ))}
      </Stack>
    </Card>
  );
}

function problemKey(problem: SessionDraftProblem): string {
  return problem.kind === 'missing_sides'
    ? `missing-${problem.sides.join('-')}`
    : `unusable-${problem.side}`;
}

function describeProblem(problem: SessionDraftProblem): string {
  if (problem.kind === 'missing_sides') {
    return problem.sides.length === 1
      ? `The ${listSides(problem.sides).toLowerCase()} has not been taken.`
      : `Still to take: ${listSides(problem.sides)}.`;
  }
  return `The ${COMPOSITION_SIDE_LABELS[problem.side].toLowerCase()} photo did not come through. Take it again.`;
}

/**
 * One tape reading, with the instruction for where to put the tape.
 *
 * The guidance sits with the field rather than on a separate screen. Someone
 * holding a tape around their waist is not going to navigate away to check
 * whether it goes at the navel, and a reading taken in the wrong place is worse
 * than no reading: it looks like data.
 *
 * The field holds what was typed, not a reformatted version of it. Rewriting
 * "83." to "83.0" mid-keystroke moves the cursor and loses the decimal the
 * athlete was about to type.
 */
export function MeasurementRow({
  point,
  unit,
  measurement,
  onChange,
  open,
  onOpen,
}: {
  point: { code: CircumferencePointCode; label: string };
  unit: MeasurementUnit;
  measurement?: BodyMeasurementDraft;
  onChange: (value: number | undefined) => void;
  /** Whether this row is showing its tape guidance. */
  open: boolean;
  onOpen: () => void;
}): React.ReactElement {
  const theme = useTheme();
  const stored = measurement
    ? formatMeasurement(fromCentimetres(measurement.centimetres, unit))
    : '';
  const [text, setText] = useState(stored);
  const shownUnit = useRef(unit);

  // Re-sync on a unit switch and on nothing else. Following the stored value
  // instead would rewrite the field on every keystroke -- typing "83" stores
  // 83, which formats back as "83.0", which lands in the field and takes the
  // cursor with it, exactly as the athlete reaches for the decimal point.
  useEffect(() => {
    if (shownUnit.current === unit) return;
    shownUnit.current = unit;
    setText(stored);
  }, [unit, stored]);

  const commit = (raw: string): void => {
    setText(raw);
    onChange(parseMeasurementInput(raw));
  };

  return (
    <Card>
      <Stack gap={spacing.sm}>
        <Stack direction="row" justify="space-between" align="center" gap={spacing.md}>
          <Stack direction="row" align="center" gap={spacing.sm} style={{ flex: 1 }}>
            <Type variant="bodyStrong">{point.label}</Type>
            {measurement ? (
              <Type variant="caption" tone="positive" accessibilityRole="text">
                recorded
              </Type>
            ) : null}
          </Stack>

          <Stack direction="row" align="center" gap={spacing.sm}>
            <TextInput
              value={text}
              onChangeText={commit}
              placeholder="—"
              placeholderTextColor={theme.color.textTertiary}
              keyboardType="decimal-pad"
              onFocus={onOpen}
              accessibilityLabel={`${point.label} in ${unit === 'cm' ? 'centimetres' : 'inches'}`}
              style={{
                minWidth: 88,
                minHeight: 44,
                paddingHorizontal: spacing.md,
                borderRadius: radius.md,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.color.border,
                backgroundColor: theme.color.surfaceRaised,
                color: theme.color.text,
                textAlign: 'right',
                ...typeStyle('metricSmall'),
              }}
            />
            <Type variant="caption" tone="tertiary">
              {UNIT_LABELS[unit]}
            </Type>
          </Stack>
        </Stack>

        {open ? (
          <Type variant="caption" tone="secondary">
            {TAPE_GUIDANCE[point.code]}
          </Type>
        ) : (
          <Pressable
            onPress={onOpen}
            accessibilityRole="button"
            accessibilityLabel={`Where to measure the ${point.label.toLowerCase()}`}
            hitSlop={8}
            style={{ minHeight: 28, justifyContent: 'center' }}
          >
            <Type variant="caption" tone="accent">
              Where to measure
            </Type>
          </Pressable>
        )}
      </Stack>
    </Card>
  );
}
