/**
 * Workout detail and post-run analysis.
 *
 * Shows provenance prominently: which services saw this run, and which fields
 * each contributed. That is what makes a merged record trustworthy rather than
 * mysterious.
 */

import React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { formatDistance, formatDuration, formatPace } from '@running/core';

import { api, type WorkoutDetail } from '../../src/lib/api';
import { useQuery } from '../../src/lib/session';
import { spacing } from '../../src/design/tokens';
import {
  Card,
  Chip,
  Divider,
  ErrorState,
  LoadingState,
  Screen,
  SectionHeader,
  Stack,
  Type,
} from '../../src/components/primitives';

export default function WorkoutDetailScreen(): React.ReactElement {
  const { id } = useLocalSearchParams<{ id: string }>();
  const workout = useQuery<WorkoutDetail>(() => api.workout(id!), [id]);

  if (workout.loading && !workout.data) return <LoadingState />;

  if (!workout.data) {
    return (
      <Screen>
        <ErrorState
          message={workout.error ?? 'Could not load this workout.'}
          onRetry={() => void workout.refresh()}
        />
      </Screen>
    );
  }

  const data = workout.data;
  const duration = data.movingTimeSeconds ?? data.durationSeconds;

  return (
    <Screen>
      <Stack gap={spacing.xl}>
        {/* Headline numbers */}
        <Card>
          <Stack gap={spacing.md}>
            <Type variant="overline" tone="tertiary">
              {data.localDate.toUpperCase()}
            </Type>
            <Type variant="title">{data.name ?? formatType(data.type)}</Type>

            <Stack direction="row" gap={spacing.xl} style={{ flexWrap: 'wrap' }}>
              {data.distanceMeters ? (
                <Stack gap={2}>
                  <Type variant="overline" tone="tertiary">
                    DISTANCE
                  </Type>
                  <Type variant="metricSmall">{formatDistance(data.distanceMeters)}</Type>
                </Stack>
              ) : null}
              {duration ? (
                <Stack gap={2}>
                  <Type variant="overline" tone="tertiary">
                    TIME
                  </Type>
                  <Type variant="metricSmall">{formatDuration(duration)}</Type>
                </Stack>
              ) : null}
              {data.avgPaceSecondsPerKm ? (
                <Stack gap={2}>
                  <Type variant="overline" tone="tertiary">
                    PACE
                  </Type>
                  <Type variant="metricSmall">{formatPace(data.avgPaceSecondsPerKm)}</Type>
                </Stack>
              ) : null}
              {data.avgHeartRateBpm ? (
                <Stack gap={2}>
                  <Type variant="overline" tone="tertiary">
                    AVG HR
                  </Type>
                  <Type variant="metricSmall">{Math.round(data.avgHeartRateBpm)}</Type>
                </Stack>
              ) : null}
            </Stack>
          </Stack>
        </Card>

        {/* Analysis */}
        {data.analysis ? (
          <>
            <Stack>
              <SectionHeader title="Analysis" />
              <Card>
                <Stack gap={spacing.md}>
                  <Type variant="body">{data.analysis.insight}</Type>

                  {data.analysis.decoupling ? (
                    <>
                      <Divider />
                      <Stack gap={spacing.xs}>
                        <Stack direction="row" justify="space-between" align="center">
                          <Type variant="body">Heart-rate drift</Type>
                          <Type variant="metricSmall">
                            {data.analysis.decoupling.driftPercent > 0 ? '+' : ''}
                            {data.analysis.decoupling.driftPercent}%
                          </Type>
                        </Stack>
                        <Type variant="caption" tone="secondary">
                          {data.analysis.decoupling.isValid
                            ? data.analysis.decoupling.interpretation
                            : (data.analysis.decoupling.invalidReason ??
                              data.analysis.decoupling.interpretation)}
                        </Type>
                      </Stack>
                    </>
                  ) : null}

                  {data.analysis.trainingEffect.trainingLoad !== undefined ? (
                    <>
                      <Divider />
                      <Stack direction="row" justify="space-between" align="center">
                        <Stack gap={2}>
                          <Type variant="body">Training load</Type>
                          {/* Naming the model matters: loads computed different
                              ways are not directly comparable. */}
                          <Type variant="caption" tone="tertiary">
                            {formatModel(data.analysis.trainingEffect.loadModel)}
                          </Type>
                        </Stack>
                        <Type variant="metricSmall">
                          {Math.round(data.analysis.trainingEffect.trainingLoad)}
                        </Type>
                      </Stack>
                    </>
                  ) : null}
                </Stack>
              </Card>
            </Stack>
          </>
        ) : null}

        {/* Provenance */}
        <Stack>
          <SectionHeader title="Where this came from" />
          <Card>
            <Stack gap={spacing.md}>
              {data.sourceRecords.map((source) => (
                <Stack key={`${source.provider}-${source.externalId}`} gap={spacing.xs}>
                  <Stack direction="row" justify="space-between" align="center">
                    <Type variant="bodyStrong">{formatProvider(source.provider)}</Type>
                    <Chip label={source.provider} />
                  </Stack>
                  {source.contributedFields.length > 0 ? (
                    <Type variant="caption" tone="tertiary">
                      Supplied: {source.contributedFields.map(formatField).join(', ')}
                    </Type>
                  ) : null}
                </Stack>
              ))}

              {data.sourceRecords.length > 1 ? (
                <>
                  <Divider />
                  <Type variant="caption" tone="secondary">
                    {data.sourceRecords.length} services recorded this run. It is counted once, with
                    each value taken from the source best placed to measure it.
                  </Type>
                </>
              ) : null}
            </Stack>
          </Card>
        </Stack>
      </Stack>
    </Screen>
  );
}

function formatType(type: string): string {
  return type
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatProvider(provider: string): string {
  return (
    { strava: 'Strava', whoop: 'WHOOP', healthkit: 'Apple Health', manual: 'Entered by you' }[
      provider
    ] ?? provider
  );
}

function formatField(field: string): string {
  return field.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
}

function formatModel(model: string | undefined): string {
  switch (model) {
    case 'trimp_hr':
      return 'From heart rate (TRIMP)';
    case 'hr_zone':
      return 'From heart-rate zones';
    case 'srpe':
      return 'From your reported effort';
    case 'duration':
      return 'Estimated from duration — no heart-rate data';
    default:
      return '';
  }
}
