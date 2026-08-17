/**
 * Onboarding.
 *
 * Ends with a concrete starting point — estimated fitness, easy pace, first
 * block — rather than an empty app. The last screen is the payoff: the athlete
 * sees the system already understands something about them.
 *
 * Connecting a provider is offered but never required. Someone with no wearable
 * can complete onboarding and get a working plan from self-reported inputs.
 */

import React, { useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatDistance, formatDuration, formatPace, parseDuration } from '@running/core';

import { api } from '../src/lib/api';
import { useSession } from '../src/lib/session';
import { radius, spacing } from '../src/design/tokens';
import { useTheme } from '../src/design/theme';
import {
  Button,
  Card,
  Chip,
  Divider,
  Stack,
  Type,
} from '../src/components/primitives';

type Step = 'goal' | 'fitness' | 'availability' | 'connect' | 'summary';

const GOALS = [
  { id: 'road_10k', label: '10K', distanceMeters: 10000 },
  { id: 'improve_5k', label: 'Faster 5K', distanceMeters: 5000 },
  { id: 'half_marathon', label: 'Half marathon', distanceMeters: 21097.5 },
  { id: 'marathon', label: 'Marathon', distanceMeters: 42195 },
  { id: 'aerobic_base', label: 'Build aerobic base' },
  { id: 'return_to_running', label: 'Return to running' },
];

const DAYS = [
  { index: 1, label: 'Mon' },
  { index: 2, label: 'Tue' },
  { index: 3, label: 'Wed' },
  { index: 4, label: 'Thu' },
  { index: 5, label: 'Fri' },
  { index: 6, label: 'Sat' },
  { index: 0, label: 'Sun' },
];

export default function OnboardingScreen(): React.ReactElement {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { markOnboarded } = useSession();

  const [step, setStep] = useState<Step>('goal');
  const [template, setTemplate] = useState('road_10k');
  const [recentTime, setRecentTime] = useState('');
  const [recentDistance, setRecentDistance] = useState(5000);
  const [weeklyKm, setWeeklyKm] = useState('25');
  const [runDays, setRunDays] = useState<number[]>([1, 2, 4, 6, 0]);
  const [longRunDay, setLongRunDay] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [summary, setSummary] = useState<{
    vo2max?: number;
    easyPace?: [number, number];
    projected?: string;
    blockName?: string;
    weeklyTarget?: number;
  }>();

  const field = {
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: theme.color.surface,
    color: theme.color.text,
    borderWidth: 1,
    borderColor: theme.color.border,
  };

  const finish = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      // 1. Availability and background.
      await api.updateMe({
        availability: {
          runDays,
          longRunDay,
          restDays: DAYS.filter((d) => !runDays.includes(d.index)).map((d) => d.index),
          strengthDays: [],
          crossTrainingDays: [],
          maxSessionsPerWeek: runDays.length,
        },
        background: {
          experience: 'recreational',
          typicalWeeklyDistanceMeters: Number(weeklyKm) * 1000 || 25000,
          typicalSessionsPerWeek: runDays.length,
        },
      });

      // 2. A recent time gives the fitness engine something real to anchor to.
      const seconds = parseDuration(recentTime);
      if (seconds) {
        await api.createRaceResult({
          distanceMeters: recentDistance,
          durationSeconds: seconds,
          date: new Date().toISOString().slice(0, 10),
          source: 'self_reported',
        });
      }

      // 3. Build the plan.
      await api.generatePlan({ template });

      // 4. Read back the starting point the athlete now has.
      const [progress, plan] = await Promise.all([api.progress(84), api.plan()]);
      const goal = GOALS.find((g) => g.id === template);
      const projection = goal?.distanceMeters
        ? progress.data.racePredictions.find((p) => p.distanceMeters === goal.distanceMeters)
        : undefined;

      setSummary({
        vo2max: progress.data.fitness.estimatedVo2Max,
        easyPace: progress.data.fitness.easyPaceRangeSecondsPerKm,
        projected: projection ? formatDuration(projection.predictedDurationSeconds) : undefined,
        blockName: plan.data.plan?.blocks[0]?.name,
        weeklyTarget: plan.data.weeks[0]?.targetDistanceMeters,
      });

      setStep('summary');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not finish setting up.');
    } finally {
      setBusy(false);
    }
  };

  const complete = async (): Promise<void> => {
    await api.completeOnboarding();
    markOnboarded();
    router.replace('/');
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.color.background }}
      contentContainerStyle={{
        padding: spacing.xl,
        paddingTop: insets.top + spacing.xl,
        paddingBottom: spacing.xxxl,
      }}
    >
      <Stack gap={spacing.xl}>
        {step === 'goal' ? (
          <Stack gap={spacing.lg}>
            <Stack gap={spacing.xs}>
              <Type variant="display">Let&apos;s build your system</Type>
              <Type variant="body" tone="secondary">
                First: what are you training for?
              </Type>
            </Stack>
            <Stack gap={spacing.sm}>
              {GOALS.map((goal) => (
                <Card
                  key={goal.id}
                  onPress={() => setTemplate(goal.id)}
                  style={
                    template === goal.id
                      ? { borderColor: theme.color.accent, borderWidth: 1.5 }
                      : undefined
                  }
                >
                  <Type variant="bodyStrong" tone={template === goal.id ? 'accent' : 'default'}>
                    {goal.label}
                  </Type>
                </Card>
              ))}
            </Stack>
            <Button label="Continue" onPress={() => setStep('fitness')} />
          </Stack>
        ) : null}

        {step === 'fitness' ? (
          <Stack gap={spacing.lg}>
            <Stack gap={spacing.xs}>
              <Type variant="title">Where are you now?</Type>
              <Type variant="body" tone="secondary">
                A recent time lets us estimate your paces properly. Skip it and we&apos;ll start
                conservatively and learn from your runs.
              </Type>
            </Stack>

            <Card>
              <Stack gap={spacing.md}>
                <Type variant="bodyStrong">Recent time</Type>
                <Stack direction="row" gap={spacing.sm}>
                  {[
                    { label: '5K', meters: 5000 },
                    { label: '10K', meters: 10000 },
                    { label: 'Half', meters: 21097.5 },
                  ].map((option) => (
                    <Chip
                      key={option.label}
                      label={option.label}
                      tone="accent"
                      selected={recentDistance === option.meters}
                      onPress={() => setRecentDistance(option.meters)}
                    />
                  ))}
                </Stack>
                <TextInput
                  value={recentTime}
                  onChangeText={setRecentTime}
                  placeholder="e.g. 25:40"
                  placeholderTextColor={theme.color.textTertiary}
                  accessibilityLabel="Recent finish time"
                  style={field}
                  keyboardType="numbers-and-punctuation"
                />
              </Stack>
            </Card>

            <Card>
              <Stack gap={spacing.md}>
                <Type variant="bodyStrong">Current weekly distance</Type>
                <TextInput
                  value={weeklyKm}
                  onChangeText={setWeeklyKm}
                  placeholder="25"
                  placeholderTextColor={theme.color.textTertiary}
                  accessibilityLabel="Weekly distance in kilometres"
                  style={field}
                  keyboardType="number-pad"
                />
                <Type variant="caption" tone="tertiary">
                  Kilometres per week. Your plan starts here, not above it.
                </Type>
              </Stack>
            </Card>

            <Button label="Continue" onPress={() => setStep('availability')} />
          </Stack>
        ) : null}

        {step === 'availability' ? (
          <Stack gap={spacing.lg}>
            <Stack gap={spacing.xs}>
              <Type variant="title">When can you run?</Type>
              <Type variant="body" tone="secondary">
                We&apos;ll never schedule a session on a day you&apos;ve ruled out.
              </Type>
            </Stack>

            <Card>
              <Stack gap={spacing.md}>
                <Type variant="bodyStrong">Training days</Type>
                <Stack direction="row" gap={spacing.xs} style={{ flexWrap: 'wrap' }}>
                  {DAYS.map((day) => (
                    <Chip
                      key={day.index}
                      label={day.label}
                      tone="accent"
                      selected={runDays.includes(day.index)}
                      onPress={() =>
                        setRunDays((prev) =>
                          prev.includes(day.index)
                            ? prev.filter((d) => d !== day.index)
                            : [...prev, day.index],
                        )
                      }
                    />
                  ))}
                </Stack>
              </Stack>
            </Card>

            <Card>
              <Stack gap={spacing.md}>
                <Type variant="bodyStrong">Long run day</Type>
                <Stack direction="row" gap={spacing.xs} style={{ flexWrap: 'wrap' }}>
                  {DAYS.filter((d) => runDays.includes(d.index)).map((day) => (
                    <Chip
                      key={day.index}
                      label={day.label}
                      tone="positive"
                      selected={longRunDay === day.index}
                      onPress={() => setLongRunDay(day.index)}
                    />
                  ))}
                </Stack>
              </Stack>
            </Card>

            <Button label="Continue" onPress={() => setStep('connect')} />
          </Stack>
        ) : null}

        {step === 'connect' ? (
          <Stack gap={spacing.lg}>
            <Stack gap={spacing.xs}>
              <Type variant="title">Connect your data</Type>
              <Type variant="body" tone="secondary">
                Optional. Connecting Strava, WHOOP or Apple Health lets the coach adapt to how you
                actually recover — but everything works without them.
              </Type>
            </Stack>

            <Button
              label="Connect data sources"
              variant="secondary"
              onPress={() => router.push('/connections')}
            />

            {error ? (
              <Type variant="caption" tone="negative">
                {error}
              </Type>
            ) : null}

            <Button label="Generate my plan" onPress={() => void finish()} loading={busy} />
          </Stack>
        ) : null}

        {step === 'summary' ? (
          <Stack gap={spacing.lg}>
            <Stack gap={spacing.xs}>
              <Type variant="display">Your starting point</Type>
              <Type variant="body" tone="secondary">
                This is what we can already say about your training.
              </Type>
            </Stack>

            <Card>
              <Stack gap={spacing.md}>
                {summary?.vo2max !== undefined ? (
                  <>
                    <Stack direction="row" justify="space-between" align="center">
                      <Type variant="body">Estimated fitness (VO₂max)</Type>
                      <Type variant="metricSmall">{summary.vo2max.toFixed(1)}</Type>
                    </Stack>
                    <Divider />
                  </>
                ) : null}

                {summary?.easyPace ? (
                  <>
                    <Stack direction="row" justify="space-between" align="center">
                      <Type variant="body">Easy pace</Type>
                      <Type variant="bodyStrong">
                        {formatPace(summary.easyPace[0]).split('/')[0]}–
                        {formatPace(summary.easyPace[1])}
                      </Type>
                    </Stack>
                    <Divider />
                  </>
                ) : null}

                {summary?.projected ? (
                  <>
                    <Stack direction="row" justify="space-between" align="center">
                      <Type variant="body">Projected finish</Type>
                      <Type variant="metricSmall">{summary.projected}</Type>
                    </Stack>
                    <Divider />
                  </>
                ) : null}

                {summary?.blockName ? (
                  <Stack direction="row" justify="space-between" align="center">
                    <Type variant="body">First block</Type>
                    <Type variant="bodyStrong">{summary.blockName}</Type>
                  </Stack>
                ) : null}

                {summary?.weeklyTarget ? (
                  <>
                    <Divider />
                    <Stack direction="row" justify="space-between" align="center">
                      <Type variant="body">Week one target</Type>
                      <Type variant="bodyStrong">{formatDistance(summary.weeklyTarget)}</Type>
                    </Stack>
                  </>
                ) : null}
              </Stack>
            </Card>

            <Card>
              <Type variant="caption" tone="tertiary">
                These are estimates from the information you gave us. They sharpen as you log runs —
                the app tells you how confident it is in every number it shows.
              </Type>
            </Card>

            <Button label="Start training" onPress={() => void complete()} />
          </Stack>
        ) : null}

        {/* Progress dots */}
        <View style={{ flexDirection: 'row', gap: spacing.xs, justifyContent: 'center' }}>
          {(['goal', 'fitness', 'availability', 'connect', 'summary'] as Step[]).map((item) => (
            <View
              key={item}
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: step === item ? theme.color.accent : theme.color.border,
              }}
            />
          ))}
        </View>
      </Stack>
    </ScrollView>
  );
}
