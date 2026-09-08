/**
 * Body composition summary.
 *
 * The module's front door. It answers one question — how does my body look
 * and measure right now? — with the latest session in a single card: the
 * body-fat estimate as a labelled range, a handful of tape measurements, and
 * the four-sided portrait.
 *
 * Every number here is a measurement the athlete took or an estimate derived
 * from one. Estimates are shown as ranges with their method and confidence and
 * are never presented as a medical figure.
 */

import React from 'react';
import { Image, RefreshControl, View } from 'react-native';

import {
  bodyComposition,
  formatBodyFatMethod,
  formatBodyFatRange,
  formatCircumference,
  formatSessionDate,
  PHOTO_SIDE_LABELS,
  PHOTO_SIDES,
  primaryEstimate,
  SUMMARY_POINT_CODES,
  type BodyCompositionSession,
  type BodyCompositionSummary,
  type CompositionPhoto,
} from '../../src/lib/body-composition';
import { useQuery } from '../../src/lib/session';
import { radius, spacing } from '../../src/design/tokens';
import { useTheme } from '../../src/design/theme';
import {
  Card,
  Chip,
  Divider,
  EmptyState,
  ErrorState,
  LoadingState,
  Screen,
  SectionHeader,
  Stack,
  Type,
} from '../../src/components/primitives';

export default function BodyCompositionScreen(): React.ReactElement {
  const theme = useTheme();
  const summary = useQuery<BodyCompositionSummary>(() => bodyComposition.summary(), []);

  if (summary.loading && !summary.data) {
    return <LoadingState label="Loading your body composition" />;
  }

  if (!summary.data) {
    return (
      <Screen>
        <ErrorState
          message={summary.error ?? 'We could not load your body composition.'}
          onRetry={() => void summary.refresh()}
        />
      </Screen>
    );
  }

  const data = summary.data;
  const latest = data.latest;

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={summary.loading}
          onRefresh={() => void summary.refresh()}
          tintColor={theme.color.textTertiary}
        />
      }
    >
      <Stack gap={spacing.xl}>
        <Stack gap={spacing.xs}>
          <Type variant="title">Body composition</Type>
          <Type variant="body" tone="secondary">
            Four photos, tape measurements and a labelled body-fat estimate, recorded session by
            session.
          </Type>
          {summary.stale ? (
            <Type variant="caption" tone="caution">
              Offline — showing your last synced data
            </Type>
          ) : null}
        </Stack>

        {latest ? (
          <LatestSessionCard session={latest} />
        ) : (
          <EmptyState
            title="No sessions yet"
            body="Record a session with four photos and your tape measurements to start tracking how your body changes."
          />
        )}

        {data.sessions.length > 0 ? (
          <Type variant="caption" tone="tertiary">
            {data.sessions.length} session{data.sessions.length === 1 ? '' : 's'} recorded since{' '}
            {formatSessionDate(data.sessions[data.sessions.length - 1]!.localDate)}.
          </Type>
        ) : null}
      </Stack>
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Latest session
// ---------------------------------------------------------------------------

function LatestSessionCard({ session }: { session: BodyCompositionSession }): React.ReactElement {
  const estimate = primaryEstimate(session);
  const byCode = new Map(session.measurements.map((m) => [m.pointCode, m]));
  const highlighted = SUMMARY_POINT_CODES.map((code) => byCode.get(code)).filter(
    (m): m is NonNullable<typeof m> => m !== undefined,
  );

  return (
    <View>
      <SectionHeader title={`Latest session · ${formatSessionDate(session.localDate)}`} />
      <Card>
        <Stack gap={spacing.lg}>
          {/* Body fat: always a range, always with its method and confidence. */}
          <Stack gap={spacing.sm}>
            <Type variant="overline" tone="tertiary">
              BODY FAT (ESTIMATE)
            </Type>
            {estimate ? (
              <>
                <Type variant="metricMedium">{formatBodyFatRange(estimate)}</Type>
                <Stack direction="row" gap={spacing.xs} style={{ flexWrap: 'wrap' }}>
                  <Chip label={formatBodyFatMethod(estimate.method)} tone="accent" selected />
                  <Chip label={`${estimate.confidenceLabel} confidence`} />
                </Stack>
                <Type variant="caption" tone="tertiary">
                  {estimate.method === 'formula'
                    ? 'Estimated from your tape measurements.'
                    : 'Estimated from your photos.'}{' '}
                  A range, not a measurement — this is not a medical figure.
                </Type>
              </>
            ) : (
              <Type variant="body" tone="secondary">
                No estimate for this session yet.
              </Type>
            )}
          </Stack>

          <Divider />

          {/* A few tape points, not all of them: the detail lives one tap deeper. */}
          <Stack gap={spacing.sm}>
            <Type variant="overline" tone="tertiary">
              MEASUREMENTS
            </Type>
            {highlighted.length > 0 ? (
              <Stack direction="row" gap={spacing.md} style={{ flexWrap: 'wrap' }}>
                {highlighted.map((measurement) => (
                  <Stack key={measurement.id} gap={2} style={{ minWidth: 96 }}>
                    <Type variant="caption" tone="secondary">
                      {measurement.pointLabel}
                    </Type>
                    <Type variant="metricSmall">
                      {formatCircumference(measurement.value, measurement.unit)}
                    </Type>
                  </Stack>
                ))}
                {session.weightKilograms !== undefined ? (
                  <Stack gap={2} style={{ minWidth: 96 }}>
                    <Type variant="caption" tone="secondary">
                      Weight
                    </Type>
                    <Type variant="metricSmall">{session.weightKilograms.toFixed(1)} kg</Type>
                  </Stack>
                ) : null}
              </Stack>
            ) : (
              <Type variant="body" tone="secondary">
                No measurements were recorded in this session.
              </Type>
            )}
          </Stack>

          <Divider />

          {/* Four-sided portrait. */}
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

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

/**
 * The four sides in a fixed order so the same side always sits in the same
 * place, which is what makes sessions comparable at a glance.
 */
function PhotoStrip({ photos }: { photos: readonly CompositionPhoto[] }): React.ReactElement {
  const theme = useTheme();
  const bySide = new Map(photos.map((photo) => [photo.side, photo]));

  return (
    <Stack direction="row" gap={spacing.sm}>
      {PHOTO_SIDES.map((side) => {
        const photo = bySide.get(side);
        const label = PHOTO_SIDE_LABELS[side];
        return (
          <View key={side} style={{ flex: 1 }} accessibilityLabel={`${label} photo`}>
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
