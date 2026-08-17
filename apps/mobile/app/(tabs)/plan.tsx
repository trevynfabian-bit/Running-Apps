/**
 * Plan.
 *
 * Shows where the athlete is in their periodisation and what each session is
 * for. Sessions carry their status (planned / completed / modified / skipped)
 * so a week that went sideways reads honestly rather than looking untouched.
 */

import React, { useState } from 'react';
import { RefreshControl, View } from 'react-native';

import { formatDistance } from '@running/core';

import { api, type PlanResponse } from '../../src/lib/api';
import { useQuery } from '../../src/lib/session';
import { spacing } from '../../src/design/tokens';
import { useTheme } from '../../src/design/theme';
import {
  Button,
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
import { ProgressBar } from '../../src/components/metrics';

const TEMPLATES = [
  { id: 'beginner_5k', label: 'Beginner 5K' },
  { id: 'improve_5k', label: 'Improve 5K' },
  { id: 'road_10k', label: '10K' },
  { id: 'half_marathon', label: 'Half marathon' },
  { id: 'marathon', label: 'Marathon' },
  { id: 'aerobic_base', label: 'Aerobic base' },
  { id: 'return_to_running', label: 'Return to running' },
  { id: 'general_fitness', label: 'General fitness' },
];

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function PlanScreen(): React.ReactElement {
  const theme = useTheme();
  const plan = useQuery<PlanResponse>(() => api.plan(), []);
  const [generating, setGenerating] = useState(false);
  const [template, setTemplate] = useState('road_10k');
  const [error, setError] = useState<string>();

  const generate = async (): Promise<void> => {
    setGenerating(true);
    setError(undefined);
    try {
      const goals = await api.raceGoals();
      await api.generatePlan({
        template,
        raceGoalId: goals.data.goals[0]?.id,
      });
      await plan.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build your plan.');
    } finally {
      setGenerating(false);
    }
  };

  if (plan.loading && !plan.data) return <LoadingState label="Loading your plan" />;

  if (!plan.data) {
    return (
      <Screen>
        <ErrorState
          message={plan.error ?? 'We could not load your plan.'}
          onRetry={() => void plan.refresh()}
        />
      </Screen>
    );
  }

  if (!plan.data.plan) {
    return (
      <Screen>
        <Stack gap={spacing.lg}>
          <EmptyState
            title="No plan yet"
            body="Pick a program and we'll build a periodised plan around your current fitness, your availability, and your goal."
          />
          <Card>
            <Stack gap={spacing.md}>
              <Type variant="bodyStrong">Choose a program</Type>
              <Stack direction="row" gap={spacing.sm} style={{ flexWrap: 'wrap' }}>
                {TEMPLATES.map((item) => (
                  <Chip
                    key={item.id}
                    label={item.label}
                    selected={template === item.id}
                    tone="accent"
                    onPress={() => setTemplate(item.id)}
                  />
                ))}
              </Stack>
              {error ? (
                <Type variant="caption" tone="negative">
                  {error}
                </Type>
              ) : null}
              <Button label="Build my plan" onPress={() => void generate()} loading={generating} />
            </Stack>
          </Card>
        </Stack>
      </Screen>
    );
  }

  const currentWeekIndex = plan.data.weeks.findIndex(
    (week) => week.completedDistanceMeters > 0 || week.workouts.some((w) => w.status === 'planned'),
  );

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={plan.loading}
          onRefresh={() => void plan.refresh()}
          tintColor={theme.color.textTertiary}
        />
      }
    >
      <Stack gap={spacing.xl}>
        {/* Block position */}
        <Card>
          <Stack gap={spacing.md}>
            <Type variant="overline" tone="tertiary">
              CURRENT BLOCK
            </Type>
            {plan.data.weeks[Math.max(0, currentWeekIndex)] ? (
              <>
                <Stack direction="row" justify="space-between" align="baseline">
                  <Type variant="title">
                    {plan.data.weeks[Math.max(0, currentWeekIndex)]!.blockName}
                  </Type>
                  <Type variant="caption" tone="tertiary">
                    Week {plan.data.weeks[Math.max(0, currentWeekIndex)]!.weekInBlock} of{' '}
                    {plan.data.weeks[Math.max(0, currentWeekIndex)]!.weeksInBlock}
                  </Type>
                </Stack>
                <Type variant="body" tone="secondary">
                  {plan.data.plan.blocks.find(
                    (b) => b.name === plan.data!.weeks[Math.max(0, currentWeekIndex)]!.blockName,
                  )?.goal ?? ''}
                </Type>
              </>
            ) : null}
          </Stack>
        </Card>

        {/* Why the plan looks the way it does */}
        {plan.data.plan.generationBasis.notes.length > 0 ? (
          <View>
            <SectionHeader title="How this plan was built" />
            <Card>
              <Stack gap={spacing.sm}>
                {plan.data.plan.generationBasis.notes.map((note, index) => (
                  <Type key={index} variant="caption" tone="secondary">
                    • {note}
                  </Type>
                ))}
              </Stack>
            </Card>
          </View>
        ) : null}

        {/* Weeks */}
        {plan.data.weeks.map((week) => (
          <View key={week.weekKey}>
            <SectionHeader title={`${week.blockName} · week ${week.weekInBlock}`} />
            <Card>
              <Stack gap={spacing.md}>
                <Stack gap={spacing.sm}>
                  <Stack direction="row" justify="space-between" align="baseline">
                    <Type variant="bodyStrong">
                      {formatDistance(week.completedDistanceMeters)}
                    </Type>
                    <Type variant="caption" tone="tertiary">
                      target {formatDistance(week.targetDistanceMeters)}
                    </Type>
                  </Stack>
                  <ProgressBar
                    value={week.completedDistanceMeters}
                    target={week.targetDistanceMeters}
                  />
                </Stack>

                <Divider />

                <Stack gap={spacing.sm}>
                  {week.workouts.map((workout) => {
                    const dayIndex = dayOfWeekIndex(workout.date);
                    return (
                      <Stack
                        key={workout.id}
                        direction="row"
                        gap={spacing.md}
                        align="center"
                        style={{ minHeight: 44 }}
                      >
                        <Type
                          variant="caption"
                          tone="tertiary"
                          style={{ width: 34 }}
                        >
                          {DAY_LABELS[dayIndex] ?? ''}
                        </Type>
                        <Stack gap={2} style={{ flex: 1 }}>
                          <Type variant="body">{workout.title}</Type>
                          {workout.targetDistanceMeters ? (
                            <Type variant="caption" tone="tertiary">
                              {formatDistance(workout.targetDistanceMeters)}
                            </Type>
                          ) : null}
                        </Stack>
                        <StatusChip status={workout.status} />
                      </Stack>
                    );
                  })}
                </Stack>
              </Stack>
            </Card>
          </View>
        ))}
      </Stack>
    </Screen>
  );
}

function StatusChip({ status }: { status: string }): React.ReactElement | null {
  switch (status) {
    case 'completed':
      return <Chip label="Done" tone="positive" selected />;
    case 'modified':
      return <Chip label="Adjusted" tone="caution" selected />;
    case 'skipped':
      return <Chip label="Skipped" tone="negative" />;
    case 'partially_completed':
      return <Chip label="Partial" tone="caution" />;
    default:
      return null;
  }
}

/** Monday-indexed day, matching DAY_LABELS. */
function dayOfWeekIndex(date: string): number {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 ? 6 : day - 1;
}
