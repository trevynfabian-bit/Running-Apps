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

import React from 'react';
import { Image, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  COMPOSITION_SIDES,
  COMPOSITION_SIDE_LABELS,
  type CompositionSide,
  type CompositionPhotoDraft,
} from '@running/core';

import { radius, spacing } from '../design/tokens';
import { useTheme } from '../design/theme';
import { Button, Card, Stack, Type } from './primitives';
import { isStubPhotoUri, stubCaptureMethod } from '../lib/composition-capture';
import { SESSION_SETUP, SIDE_GUIDANCE } from '../lib/composition-guidance';

/** Portrait. A standing body fits this far better than a square crop. */
const ASPECT_RATIO = 3 / 4;

export function SidePhotoTile({
  side,
  photo,
  onPress,
  caption,
}: {
  side: CompositionSide;
  photo?: CompositionPhotoDraft;
  onPress?: () => void;
  caption?: string;
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
