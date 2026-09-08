/**
 * Progress.
 *
 * The screen that answers "am I actually getting fitter?".
 *
 * Every trend shows its confidence, and every projection is labelled an
 * estimate with the evidence it came from. A number without that context
 * invites the athlete to over-read normal week-to-week noise.
 */

import React, { useState } from 'react';
import { RefreshControl, View } from 'react-native';
import { router } from 'expo-router';

import { formatDuration, formatPace } from '@running/core';

import { api, type ProgressResponse } from '../../src/lib/api';
import { useQuery } from '../../src/lib/session';
import { spacing } from '../../src/design/tokens';
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
import { Sparkline, TrendRow } from '../../src/components/metrics';

const WINDOWS = [
  { label: '4 weeks', days: 28 },
  { label: '8 weeks', days: 56 },
  { label: '12 weeks', days: 84 },
];

export default function ProgressScreen(): React.ReactElement {
  const theme = useTheme();
  const [windowDays, setWindowDays] = useState(84);
  const progress = useQuery<ProgressResponse>(() => api.progress(windowDays), [windowDays]);

  if (progress.loading && !progress.data) return <LoadingState label="Analysing your training" />;

  if (!progress.data) {
    return (
      <Screen>
        <ErrorState
          message={progress.error ?? 'We could not load your progress.'}
          onRetry={() => void progress.refresh()}
        />
      </Screen>
    );
  }

  const data = progress.data;
  const hasTraining = data.training.weeklyDistance.length > 0;

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={progress.loading}
          onRefresh={() => void progress.refresh()}
          tintColor={theme.color.textTertiary}
        />
      }
    >
      <Stack gap={spacing.xl}>
        {/* Window selector */}
        <Stack direction="row" gap={spacing.sm}>
          {WINDOWS.map((option) => (
            <Chip
              key={option.days}
              label={option.label}
              tone="accent"
              selected={windowDays === option.days}
              onPress={() => setWindowDays(option.days)}
            />
          ))}
        </Stack>

        {!hasTraining ? (
          <EmptyState
            title="Not enough data yet"
            body="Complete three to five runs and we'll start identifying your trends."
          />
        ) : null}

        {/* Fitness */}
        <View>
          <SectionHeader title="Fitness" />
          <Card>
            <Stack gap={spacing.md}>
              {data.fitness.estimatedVo2Max !== undefined ? (
                <Stack direction="row" justify="space-between" align="baseline">
                  <Stack gap={2}>
                    {/* Always labelled estimated — this is not a lab measurement. */}
                    <Type variant="body">Estimated VO₂max</Type>
                    <Type variant="caption" tone="tertiary">
                      {data.fitness.basis}
                    </Type>
                  </Stack>
                  <Type variant="metricSmall">{data.fitness.estimatedVo2Max.toFixed(1)}</Type>
                </Stack>
              ) : (
                <Type variant="body" tone="secondary">
                  Run a race or a time trial and we can estimate your fitness.
                </Type>
              )}

              {data.fitness.thresholdPaceSecondsPerKm ? (
                <>
                  <Divider />
                  <Stack direction="row" justify="space-between" align="center">
                    <Type variant="body">Estimated threshold pace</Type>
                    <Type variant="metricSmall">
                      {formatPace(data.fitness.thresholdPaceSecondsPerKm)}
                    </Type>
                  </Stack>
                </>
              ) : null}

              {data.fitness.easyPaceRangeSecondsPerKm ? (
                <>
                  <Divider />
                  <Stack direction="row" justify="space-between" align="center">
                    <Type variant="body">Easy pace range</Type>
                    <Type variant="bodyStrong">
                      {formatPace(data.fitness.easyPaceRangeSecondsPerKm[0]).split('/')[0]}–
                      {formatPace(data.fitness.easyPaceRangeSecondsPerKm[1])}
                    </Type>
                  </Stack>
                </>
              ) : null}

              {data.fitness.aerobicEfficiency ? (
                <>
                  <Divider />
                  <TrendRow
                    label="Aerobic efficiency"
                    value={
                      data.fitness.aerobicEfficiency.percentChange !== undefined
                        ? `${data.fitness.aerobicEfficiency.percentChange > 0 ? '+' : ''}${data.fitness.aerobicEfficiency.percentChange.toFixed(1)}%`
                        : '—'
                    }
                    direction={data.fitness.aerobicEfficiency.direction}
                    confidence={data.fitness.aerobicEfficiency.confidence}
                  />
                  <Type variant="caption" tone="secondary">
                    {data.fitness.aerobicEfficiency.summary}
                  </Type>
                </>
              ) : null}
            </Stack>
          </Card>
        </View>

        {/* Training */}
        {hasTraining ? (
          <View>
            <SectionHeader title="Training" />
            <Card>
              <Stack gap={spacing.md}>
                <Stack gap={spacing.xs}>
                  <Type variant="overline" tone="tertiary">
                    WEEKLY DISTANCE (KM)
                  </Type>
                  <Sparkline points={data.training.weeklyDistance} />
                </Stack>
                {data.training.distanceTrend ? (
                  <>
                    <Divider />
                    <TrendRow
                      label="Weekly volume"
                      value={`${data.training.weeklyDistance[data.training.weeklyDistance.length - 1]?.value.toFixed(1) ?? '—'} km`}
                      direction={data.training.distanceTrend.direction}
                      change={
                        data.training.distanceTrend.percentChange !== undefined
                          ? `${data.training.distanceTrend.percentChange > 0 ? '+' : ''}${data.training.distanceTrend.percentChange.toFixed(0)}%`
                          : undefined
                      }
                      confidence={data.training.distanceTrend.confidence}
                    />
                  </>
                ) : null}
              </Stack>
            </Card>
          </View>
        ) : null}

        {/* Recovery */}
        {data.recovery.recoveryScore.length > 0 || data.recovery.hrv.length > 0 ? (
          <View>
            <SectionHeader title="Recovery" />
            <Card>
              <Stack gap={spacing.md}>
                {data.recovery.recoveryScore.length > 1 ? (
                  <Stack gap={spacing.xs}>
                    <Type variant="overline" tone="tertiary">
                      READINESS
                    </Type>
                    <Sparkline points={data.recovery.recoveryScore} tone="positive" />
                  </Stack>
                ) : null}

                {data.recovery.hrvTrend ? (
                  <>
                    <Divider />
                    <TrendRow
                      label="Heart rate variability"
                      value={`${data.recovery.hrv[data.recovery.hrv.length - 1]?.value.toFixed(0) ?? '—'} ms`}
                      direction={data.recovery.hrvTrend.direction}
                      change={
                        data.recovery.hrvTrend.percentChange !== undefined
                          ? `${data.recovery.hrvTrend.percentChange > 0 ? '+' : ''}${data.recovery.hrvTrend.percentChange.toFixed(1)}%`
                          : undefined
                      }
                      confidence={data.recovery.hrvTrend.confidence}
                    />
                  </>
                ) : null}

                {data.recovery.restingHrTrend ? (
                  <>
                    <Divider />
                    <TrendRow
                      label="Resting heart rate"
                      value={`${data.recovery.restingHeartRate[data.recovery.restingHeartRate.length - 1]?.value.toFixed(0) ?? '—'} bpm`}
                      direction={data.recovery.restingHrTrend.direction}
                      change={
                        data.recovery.restingHrTrend.percentChange !== undefined
                          ? `${data.recovery.restingHrTrend.percentChange.toFixed(1)}%`
                          : undefined
                      }
                      confidence={data.recovery.restingHrTrend.confidence}
                    />
                  </>
                ) : null}
              </Stack>
            </Card>
          </View>
        ) : null}

        {/* Body */}
        {data.body.weightKilograms.length > 1 ? (
          <View>
            <SectionHeader title="Body" />
            <Card>
              <Stack gap={spacing.md}>
                <Sparkline points={data.body.weightKilograms} tone="accent" />
                {data.body.weightTrend ? (
                  <TrendRow
                    label="Weight"
                    value={`${data.body.weightKilograms[data.body.weightKilograms.length - 1]?.value.toFixed(1) ?? '—'} kg`}
                    direction={data.body.weightTrend.direction}
                    confidence={data.body.weightTrend.confidence}
                  />
                ) : null}
              </Stack>
            </Card>
          </View>
        ) : null}

        {/* Body composition lives on its own screen: photos and tape measurements
            are a different kind of record from a training trend. */}
        <View>
          <SectionHeader title="Body composition" />
          <Card
            onPress={() => router.push('/body-composition')}
            accessibilityLabel="Open body composition"
          >
            <Stack direction="row" justify="space-between" align="center" gap={spacing.md}>
              <Stack gap={2} style={{ flex: 1 }}>
                <Type variant="bodyStrong">Photos, measurements and body-fat estimate</Type>
                <Type variant="caption" tone="secondary">
                  Track how your body is changing, session by session.
                </Type>
              </Stack>
              <Type variant="caption" tone="accent">
                Open
              </Type>
            </Stack>
          </Card>
        </View>

        {/* Race predictions */}
        {data.racePredictions.length > 0 ? (
          <View>
            <SectionHeader title="Race predictions" />
            <Card>
              <Stack gap={spacing.sm}>
                {data.racePredictions.map((prediction, index) => (
                  <React.Fragment key={prediction.distanceMeters}>
                    {index > 0 ? <Divider /> : null}
                    <Stack
                      direction="row"
                      justify="space-between"
                      align="center"
                      style={{ minHeight: 44 }}
                    >
                      <Stack gap={2} style={{ flex: 1 }}>
                        <Type variant="body">{prediction.label}</Type>
                        <Type variant="caption" tone="tertiary">
                          {formatPace(prediction.predictedPaceSecondsPerKm)} ·{' '}
                          {prediction.confidence} confidence
                        </Type>
                      </Stack>
                      <Type variant="metricSmall">
                        {formatDuration(prediction.predictedDurationSeconds)}
                      </Type>
                    </Stack>
                  </React.Fragment>
                ))}
                <Type variant="caption" tone="tertiary" style={{ marginTop: spacing.sm }}>
                  Estimated from your recent training. Longer distances are extrapolated further and
                  carry lower confidence.
                </Type>
              </Stack>
            </Card>
          </View>
        ) : null}
      </Stack>
    </Screen>
  );
}
