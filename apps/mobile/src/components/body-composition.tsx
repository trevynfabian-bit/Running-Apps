/**
 * Body composition components.
 *
 * The latest-status card is the module's headline: one card that says how the
 * athlete's body measures and looks right now. It is built from three parts
 * that later screens reuse on their own — the body-fat range, the measurement
 * tiles and the four-sided photo strip.
 *
 * Product rules these components enforce:
 *   - A body-fat estimate is rendered only as a range with its method and
 *     confidence, never as a single figure, and always with a non-medical note.
 *   - Photos sit in a fixed front/back/left/right order so sessions line up.
 *   - Nothing is fabricated: a missing photo says so, a missing estimate says so.
 */

import React from 'react';
import { Image, View } from 'react-native';

import {
  formatBodyFatMethod,
  formatBodyFatRange,
  formatCircumference,
  formatDaysAgo,
  formatSessionDate,
  PHOTO_SIDE_LABELS,
  PHOTO_SIDES,
  primaryEstimate,
  SUMMARY_POINT_CODES,
  type BodyCompositionSession,
  type BodyFatEstimate,
  type BodyMeasurement,
  type CompositionPhoto,
} from '../lib/body-composition';
import { radius, spacing } from '../design/tokens';
import { useTheme } from '../design/theme';
import { Card, Chip, Divider, EmptyState, SectionHeader, Stack, Type } from './primitives';

// ---------------------------------------------------------------------------
// Latest status
// ---------------------------------------------------------------------------

/**
 * The most recent session in one card: estimate, a few tape points, photos.
 */
export function LatestStatusCard({
  session,
  onPress,
}: {
  session: BodyCompositionSession;
  /** Opens the session detail, once there is one to open. */
  onPress?: () => void;
}): React.ReactElement {
  const estimate = primaryEstimate(session);
  const byCode = new Map(session.measurements.map((m) => [m.pointCode, m]));
  const highlighted = SUMMARY_POINT_CODES.map((code) => byCode.get(code)).filter(
    (m): m is BodyMeasurement => m !== undefined,
  );
  const daysAgo = formatDaysAgo(session.localDate);

  return (
    <View>
      <SectionHeader title="Latest session" />
      <Card
        onPress={onPress}
        accessibilityLabel={`Latest session, ${formatSessionDate(session.localDate)}`}
      >
        <Stack gap={spacing.lg}>
          <Stack direction="row" justify="space-between" align="baseline">
            <Type variant="bodyStrong">{formatSessionDate(session.localDate)}</Type>
            {daysAgo ? (
              <Type variant="caption" tone="tertiary">
                {daysAgo}
              </Type>
            ) : null}
          </Stack>

          <BodyFatRange estimate={estimate} />

          <Divider />

          <MeasurementTiles measurements={highlighted} weightKilograms={session.weightKilograms} />

          <Divider />

          <Stack gap={spacing.sm}>
            <Type variant="overline" tone="tertiary">
              PHOTOS
            </Type>
            <PhotoStrip photos={session.photos} />
          </Stack>
        </Stack>
      </Card>
    </View>
  );
}

/**
 * First-run state. Says what a session is before asking for one, and takes an
 * optional action so the caller can offer to start it.
 */
export function LatestStatusEmpty({
  onStartSession,
}: {
  onStartSession?: () => void;
}): React.ReactElement {
  return (
    <View>
      <SectionHeader title="Latest session" />
      <EmptyState
        title="No sessions yet"
        body="A session is four photos, your tape measurements and a body-fat estimate, recorded together so later sessions can be compared with it."
        action={
          onStartSession
            ? { label: 'Start your first session', onPress: onStartSession }
            : undefined
        }
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/**
 * Body-fat estimate as a labelled range. The method and confidence chips are
 * not decoration: a tape-formula range and a photo-AI range are different
 * kinds of claim, and the athlete is entitled to tell them apart.
 */
export function BodyFatRange({ estimate }: { estimate?: BodyFatEstimate }): React.ReactElement {
  return (
    <Stack gap={spacing.sm}>
      <Type variant="overline" tone="tertiary">
        BODY FAT (ESTIMATE)
      </Type>
      {estimate ? (
        <>
          <View
            accessible
            accessibilityLabel={`Estimated body fat ${formatBodyFatRange(estimate)}, ${estimate.confidenceLabel} confidence`}
          >
            <Type variant="metricMedium">{formatBodyFatRange(estimate)}</Type>
          </View>
          <Stack direction="row" gap={spacing.xs} style={{ flexWrap: 'wrap' }}>
            <Chip label={formatBodyFatMethod(estimate.method)} tone="accent" selected />
            <Chip label={`${estimate.confidenceLabel} confidence`} />
          </Stack>
          <Type variant="caption" tone="tertiary">
            {estimate.method === 'formula'
              ? 'Estimated from your tape measurements.'
              : 'Estimated from your photos.'}{' '}
            A range, not a measurement. This is not a medical figure.
          </Type>
        </>
      ) : (
        <Type variant="body" tone="secondary">
          No estimate for this session yet. Add tape measurements to get one.
        </Type>
      )}
    </Stack>
  );
}

/**
 * A handful of tape points plus weight. Deliberately not every point: the
 * summary shows what changes a decision, and the full list lives one tap deeper.
 */
export function MeasurementTiles({
  measurements,
  weightKilograms,
}: {
  measurements: readonly BodyMeasurement[];
  weightKilograms?: number;
}): React.ReactElement {
  const hasAnything = measurements.length > 0 || weightKilograms !== undefined;

  return (
    <Stack gap={spacing.sm}>
      <Type variant="overline" tone="tertiary">
        MEASUREMENTS
      </Type>
      {hasAnything ? (
        <Stack direction="row" gap={spacing.md} style={{ flexWrap: 'wrap' }}>
          {measurements.map((measurement) => (
            <View
              key={measurement.id}
              accessible
              accessibilityLabel={`${measurement.pointLabel} ${formatCircumference(measurement.value, measurement.unit)}`}
              style={{ minWidth: 96, gap: 2 }}
            >
              <Type variant="caption" tone="secondary">
                {measurement.pointLabel}
              </Type>
              <Type variant="metricSmall">
                {formatCircumference(measurement.value, measurement.unit)}
              </Type>
            </View>
          ))}
          {weightKilograms !== undefined ? (
            <View
              accessible
              accessibilityLabel={`Weight ${weightKilograms.toFixed(1)} kilograms`}
              style={{ minWidth: 96, gap: 2 }}
            >
              <Type variant="caption" tone="secondary">
                Weight
              </Type>
              <Type variant="metricSmall">{weightKilograms.toFixed(1)} kg</Type>
            </View>
          ) : null}
        </Stack>
      ) : (
        <Type variant="body" tone="secondary">
          No measurements were recorded in this session.
        </Type>
      )}
    </Stack>
  );
}

/**
 * The four sides in a fixed order so the same side always sits in the same
 * place, which is what makes sessions comparable at a glance.
 */
export function PhotoStrip({
  photos,
  size = 'small',
}: {
  photos: readonly CompositionPhoto[];
  /** `small` for summary cards; `large` for review and comparison screens. */
  size?: 'small' | 'large';
}): React.ReactElement {
  const theme = useTheme();
  const bySide = new Map(photos.map((photo) => [photo.side, photo]));

  return (
    <Stack direction="row" gap={size === 'large' ? spacing.md : spacing.sm}>
      {PHOTO_SIDES.map((side) => {
        const photo = bySide.get(side);
        const label = PHOTO_SIDE_LABELS[side];
        return (
          <View
            key={side}
            style={{ flex: 1 }}
            accessibilityLabel={
              photo?.uri ? `${label} photo` : `${label} photo, ${photo ? 'no preview' : 'missing'}`
            }
          >
            <View
              style={{
                aspectRatio: 3 / 4,
                borderRadius: radius.md,
                overflow: 'hidden',
                backgroundColor: theme.color.surfaceRaised,
                borderWidth: 1,
                borderColor: theme.color.border,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {photo?.uri ? (
                <Image
                  source={{ uri: photo.uri }}
                  style={{ width: '100%', height: '100%' }}
                  resizeMode="cover"
                  accessibilityIgnoresInvertColors
                />
              ) : (
                // No stored image: say so rather than showing a broken image.
                <Type variant="caption" tone="tertiary">
                  {photo ? 'No preview' : 'Missing'}
                </Type>
              )}
            </View>
            <Type
              variant="caption"
              tone="secondary"
              style={{ textAlign: 'center', marginTop: spacing.xs }}
            >
              {label}
            </Type>
          </View>
        );
      })}
    </Stack>
  );
}
