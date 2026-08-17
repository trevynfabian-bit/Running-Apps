/**
 * Home.
 *
 * This screen answers exactly one question: what should I do today?
 *
 * Everything else — the physiology, the load ratios, the trend maths — sits
 * behind a tap. The backend computes hundreds of numbers; showing them all
 * here would make the athlete do the synthesis the product exists to do for
 * them.
 */

import React, { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatDistance, formatDuration } from '@running/core';

import { api, type DashboardResponse } from '../../src/lib/api';
import { useQuery } from '../../src/lib/session';
import { spacing } from '../../src/design/tokens';
import { useTheme } from '../../src/design/theme';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  LoadingState,
  SectionHeader,
  Stack,
  Type,
} from '../../src/components/primitives';
import {
  CoachMessage,
  MetricCard,
  ProgressBar,
  ReadinessRing,
} from '../../src/components/metrics';
import { CheckInSheet } from '../../src/components/check-in';

export default function HomeScreen(): React.ReactElement {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [checkInOpen, setCheckInOpen] = useState(false);

  const dashboard = useQuery<DashboardResponse>(() => api.dashboard(), []);

  if (dashboard.loading && !dashboard.data) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.color.background, paddingTop: insets.top }}>
        <LoadingState label="Reading your training" />
      </View>
    );
  }

  if (!dashboard.data) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: theme.color.background,
          paddingTop: insets.top + spacing.xl,
          padding: spacing.lg,
        }}
      >
        <ErrorState
          message={dashboard.error ?? 'We could not load your dashboard.'}
          onRetry={() => void dashboard.refresh()}
        />
      </View>
    );
  }

  const data = dashboard.data;
  const workout = data.todayWorkout;

  return (
    <>
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.color.background }}
        contentContainerStyle={{
          padding: spacing.lg,
          paddingTop: insets.top + spacing.md,
          paddingBottom: spacing.xxxl * 2,
        }}
        refreshControl={
          <RefreshControl
            refreshing={dashboard.loading}
            onRefresh={() => void dashboard.refresh()}
            tintColor={theme.color.textTertiary}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <Stack gap={spacing.xl}>
          {/* Greeting */}
          <Stack gap={spacing.xs}>
            <Type variant="title">{data.greeting}</Type>
            {dashboard.stale ? (
              <Type variant="caption" tone="caution">
                Offline — showing your last synced data
              </Type>
            ) : null}
          </Stack>

          {/* Readiness. The single number the whole screen orients around. */}
          <Card>
            <Stack direction="row" gap={spacing.lg} align="center">
              <ReadinessRing score={data.readiness.score} band={data.readiness.band} />
              <Stack gap={spacing.sm} style={{ flex: 1 }}>
                <Type variant="body" tone="secondary">
                  {data.readiness.summary}
                </Type>
                {data.readiness.dataCompleteness < 0.5 ? (
                  <Chip label="Limited data" tone="caution" />
                ) : null}
              </Stack>
            </Stack>
          </Card>

          {/* Morning check-in prompt — 10 seconds, once a day, never nagging. */}
          {data.needsCheckIn ? (
            <Card>
              <Stack gap={spacing.md}>
                <Type variant="bodyStrong">How do you feel today?</Type>
                <Type variant="body" tone="secondary">
                  Ten seconds. It measurably improves how well today&apos;s session fits you.
                </Type>
                <Button label="Check in" onPress={() => setCheckInOpen(true)} />
              </Stack>
            </Card>
          ) : null}

          {/* Today's session */}
          <View>
            <SectionHeader title="Today" />
            {workout ? (
              <Card>
                <Stack gap={spacing.md}>
                  <Stack gap={spacing.xs}>
                    <Stack direction="row" gap={spacing.sm} align="center">
                      <Type variant="metricSmall">{workout.title}</Type>
                      {workout.status === 'modified' ? (
                        <Chip label="Adjusted" tone="caution" />
                      ) : null}
                    </Stack>
                    <Type variant="body" tone="secondary">
                      {workout.purpose}
                    </Type>
                  </Stack>

                  <Stack direction="row" gap={spacing.xl}>
                    {workout.targetDistanceMeters ? (
                      <Stack gap={2}>
                        <Type variant="overline" tone="tertiary">
                          DISTANCE
                        </Type>
                        <Type variant="metricSmall">
                          {formatDistance(workout.targetDistanceMeters)}
                        </Type>
                      </Stack>
                    ) : null}
                    {workout.targetDurationSeconds ? (
                      <Stack gap={2}>
                        <Type variant="overline" tone="tertiary">
                          TIME
                        </Type>
                        <Type variant="metricSmall">
                          {formatDuration(workout.targetDurationSeconds)}
                        </Type>
                      </Stack>
                    ) : null}
                    {workout.targetRpe ? (
                      <Stack gap={2}>
                        <Type variant="overline" tone="tertiary">
                          EFFORT
                        </Type>
                        <Type variant="metricSmall">{workout.targetRpe}/10</Type>
                      </Stack>
                    ) : null}
                  </Stack>

                  {workout.type !== 'rest' ? (
                    <Button label="Start workout" onPress={() => router.push('/train')} />
                  ) : null}
                </Stack>
              </Card>
            ) : (
              <EmptyState
                title="Nothing scheduled"
                body="Generate a training plan and your daily sessions will appear here."
                action={{ label: 'Build a plan', onPress: () => router.push('/plan') }}
              />
            )}
          </View>

          {/* The coach's reasoning, always with a Why? */}
          {data.decision ? (
            <CoachMessage
              headline={data.decision.headline}
              body={data.readiness.summary}
              explanation={data.decision.explanation}
              tone={
                data.decision.decision === 'REST'
                  ? 'negative'
                  : data.decision.decision === 'RUN_AS_PLANNED'
                    ? 'default'
                    : 'caution'
              }
              onWhy={(explanation) =>
                router.push({
                  pathname: '/why',
                  params: { title: data.decision!.headline, explanation },
                })
              }
            />
          ) : null}

          {/* Referral prompt — a signpost, never a diagnosis. */}
          {data.trainingState.recommendProfessionalReview ? (
            <Card style={{ borderColor: theme.color.caution }}>
              <Stack gap={spacing.sm}>
                <Type variant="bodyStrong" tone="caution">
                  Worth getting checked
                </Type>
                <Type variant="body" tone="secondary">
                  Your recent signals suggest unusually high fatigue. If this persists, or you have
                  pain, it is worth discussing with a qualified health professional. This app does
                  not diagnose injuries or medical conditions.
                </Type>
              </Stack>
            </Card>
          ) : null}

          {/* Week at a glance */}
          <View>
            <SectionHeader title="This week" action={{ label: 'Plan', onPress: () => router.push('/plan') }} />
            <Card>
              <Stack gap={spacing.md}>
                <Stack direction="row" justify="space-between" align="baseline">
                  <Type variant="metricSmall">
                    {formatDistance(data.weeklyProgress.completedDistanceMeters)}
                  </Type>
                  <Type variant="caption" tone="tertiary">
                    of {formatDistance(data.weeklyProgress.targetDistanceMeters)}
                  </Type>
                </Stack>
                <ProgressBar
                  value={data.weeklyProgress.completedDistanceMeters}
                  target={data.weeklyProgress.targetDistanceMeters}
                />
                <Stack direction="row" justify="space-between">
                  <Type variant="caption" tone="secondary">
                    {data.weeklyProgress.completedSessions} of{' '}
                    {data.weeklyProgress.plannedSessions} sessions
                  </Type>
                  {data.currentBlock ? (
                    <Type variant="caption" tone="tertiary">
                      {data.currentBlock.name} · week {data.currentBlock.weekInBlock}/
                      {data.currentBlock.weeksInBlock}
                    </Type>
                  ) : null}
                </Stack>
              </Stack>
            </Card>
          </View>

          {/* Status tiles */}
          <Stack direction="row" gap={spacing.md}>
            <MetricCard
              label="Training status"
              value={formatState(data.trainingState.state)}
              detail={data.trainingState.summary}
              tone={
                data.trainingState.state === 'overreaching_risk' ||
                data.trainingState.state === 'highly_fatigued'
                  ? 'negative'
                  : data.trainingState.state === 'fatigued'
                    ? 'caution'
                    : 'default'
              }
            />
          </Stack>

          {/* Race goal */}
          {data.raceGoal ? (
            <View>
              <SectionHeader title="Race goal" />
              <Card onPress={() => router.push('/progress')}>
                <Stack gap={spacing.md}>
                  <Stack direction="row" justify="space-between" align="center">
                    <Type variant="bodyStrong">{data.raceGoal.name}</Type>
                    <Chip label={`${data.raceGoal.weeksRemaining} weeks`} />
                  </Stack>
                  <Stack direction="row" gap={spacing.xl}>
                    {data.raceGoal.targetDurationSeconds ? (
                      <Stack gap={2}>
                        <Type variant="overline" tone="tertiary">
                          TARGET
                        </Type>
                        <Type variant="metricSmall">
                          {formatDuration(data.raceGoal.targetDurationSeconds)}
                        </Type>
                      </Stack>
                    ) : null}
                    {data.raceGoal.currentEstimateSeconds ? (
                      <Stack gap={2}>
                        <Type variant="overline" tone="tertiary">
                          PROJECTED
                        </Type>
                        <Type variant="metricSmall">
                          {formatDuration(data.raceGoal.currentEstimateSeconds)}
                        </Type>
                      </Stack>
                    ) : null}
                    {data.raceGoal.gapSeconds !== undefined ? (
                      <Stack gap={2}>
                        <Type variant="overline" tone="tertiary">
                          GAP
                        </Type>
                        <Type
                          variant="metricSmall"
                          tone={data.raceGoal.gapSeconds <= 0 ? 'positive' : 'caution'}
                        >
                          {data.raceGoal.gapSeconds <= 0 ? '−' : '+'}
                          {formatDuration(Math.abs(data.raceGoal.gapSeconds))}
                        </Type>
                      </Stack>
                    ) : null}
                  </Stack>
                  {/* Projections are estimates and must always say so. */}
                  <Type variant="caption" tone="tertiary">
                    Projection is an estimate · {data.raceGoal.confidence} confidence
                  </Type>
                </Stack>
              </Card>
            </View>
          ) : null}

          <Button
            label="Connected data"
            variant="ghost"
            onPress={() => router.push('/connections')}
          />
        </Stack>
      </ScrollView>

      <CheckInSheet
        visible={checkInOpen}
        onClose={() => setCheckInOpen(false)}
        onSubmitted={() => {
          setCheckInOpen(false);
          void dashboard.refresh();
        }}
      />
    </>
  );
}

function formatState(state: string): string {
  return state
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
