/**
 * Train.
 *
 * Executes today's session. The structured-workout player steps through
 * warm-up, main set and cool-down with a live timer.
 *
 * An explicit product decision: this screen does NOT display live pace,
 * distance or heart rate. Doing so would require background location and a
 * connected sensor, and showing a fabricated or stale number to someone
 * mid-interval is worse than showing none. Elapsed time and the prescription
 * are real and are what the athlete needs to execute the session; GPS and
 * sensor capture are a separate piece of work, and the completed run is
 * imported from Strava/HealthKit afterwards either way.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import { formatDistance, formatDuration } from '@running/core';

import { api, type DashboardResponse, type WorkoutStep } from '../../src/lib/api';
import { useQuery } from '../../src/lib/session';
import { spacing } from '../../src/design/tokens';
import { useTheme } from '../../src/design/theme';
import {
  Button,
  Card,
  Chip,
  Divider,
  EmptyState,
  LoadingState,
  Screen,
  SectionHeader,
  Stack,
  Type,
} from '../../src/components/primitives';

interface FlatStep {
  id: string;
  label: string;
  durationSeconds?: number;
  distanceMeters?: number;
  isRecovery?: boolean;
  /** e.g. "Interval 2 of 5" */
  repetitionLabel?: string;
}

/** Expand repeats into a linear list the player can walk through. */
function flattenStructure(workout: DashboardResponse['todayWorkout']): FlatStep[] {
  if (!workout?.structure) {
    // An unstructured session is a single continuous step.
    return [
      {
        id: 'main',
        label: workout?.title ?? 'Run',
        durationSeconds: workout?.targetDurationSeconds,
        distanceMeters: workout?.targetDistanceMeters,
      },
    ];
  }

  const steps: FlatStep[] = [];
  const toFlat = (step: WorkoutStep, repetitionLabel?: string): FlatStep => ({
    id: `${step.id}-${repetitionLabel ?? ''}`,
    label: step.label,
    durationSeconds: step.durationSeconds,
    distanceMeters: step.distanceMeters,
    isRecovery: step.isRecovery,
    repetitionLabel,
  });

  if (workout.structure.warmup) steps.push(toFlat(workout.structure.warmup));

  for (const segment of workout.structure.main) {
    if (segment.kind === 'step') {
      steps.push(toFlat(segment.step));
      continue;
    }
    for (let rep = 1; rep <= segment.repeat.repetitions; rep++) {
      for (const step of segment.repeat.steps) {
        steps.push(toFlat(step, `${rep} of ${segment.repeat.repetitions}`));
      }
    }
  }

  if (workout.structure.cooldown) steps.push(toFlat(workout.structure.cooldown));
  return steps;
}

export default function TrainScreen(): React.ReactElement {
  const theme = useTheme();
  const dashboard = useQuery<DashboardResponse>(() => api.dashboard(), []);

  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [stepElapsed, setStepElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const workout = dashboard.data?.todayWorkout;
  const steps = useMemo(() => flattenStructure(workout), [workout]);
  const currentStep = steps[stepIndex];

  useEffect(() => {
    if (!running) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = setInterval(() => {
      setElapsed((value) => value + 1);
      setStepElapsed((value) => value + 1);
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [running]);

  // Auto-advance when a timed step completes.
  useEffect(() => {
    if (!running || !currentStep?.durationSeconds) return;
    if (stepElapsed >= currentStep.durationSeconds && stepIndex < steps.length - 1) {
      setStepIndex((index) => index + 1);
      setStepElapsed(0);
    }
  }, [running, stepElapsed, currentStep, stepIndex, steps.length]);

  const finish = useCallback(async () => {
    setRunning(false);
    if (!workout) return;
    try {
      await api.logWorkout({
        type: workout.type,
        sport: 'run',
        startTime: new Date(Date.now() - elapsed * 1000).toISOString(),
        durationSeconds: Math.max(1, elapsed),
        distanceMeters: workout.targetDistanceMeters,
      });
      await dashboard.refresh();
    } catch {
      // The session still ends locally; the sync engine will reconcile the
      // real activity when Strava or Apple Health delivers it.
    }
    setElapsed(0);
    setStepIndex(0);
    setStepElapsed(0);
  }, [workout, elapsed, dashboard]);

  if (dashboard.loading && !dashboard.data) return <LoadingState />;

  if (!workout || workout.type === 'rest') {
    return (
      <Screen>
        <EmptyState
          title={workout ? 'Rest day' : 'Nothing scheduled'}
          body={
            workout
              ? 'Recovery is training. Nothing to execute today.'
              : 'Build a plan and your sessions will appear here.'
          }
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack gap={spacing.xl}>
        <Stack gap={spacing.xs}>
          <Type variant="title">{workout.title}</Type>
          <Type variant="body" tone="secondary">
            {workout.purpose}
          </Type>
        </Stack>

        {/* Timer */}
        <Card style={{ alignItems: 'center', paddingVertical: spacing.xl }}>
          <Stack gap={spacing.sm} align="center">
            <Type variant="overline" tone="tertiary">
              ELAPSED
            </Type>
            <Type variant="metricLarge">{formatDuration(elapsed, true)}</Type>
            {currentStep ? (
              <Stack gap={spacing.xs} align="center">
                <Type variant="bodyStrong" tone={currentStep.isRecovery ? 'secondary' : 'default'}>
                  {currentStep.label}
                  {currentStep.repetitionLabel ? ` · ${currentStep.repetitionLabel}` : ''}
                </Type>
                {currentStep.durationSeconds ? (
                  <Type variant="metricSmall" tone="accent">
                    {formatDuration(Math.max(0, currentStep.durationSeconds - stepElapsed))} left
                  </Type>
                ) : currentStep.distanceMeters ? (
                  <Type variant="caption" tone="tertiary">
                    {formatDistance(currentStep.distanceMeters)}
                  </Type>
                ) : null}
              </Stack>
            ) : null}
          </Stack>
        </Card>

        {/* Controls */}
        <Stack gap={spacing.sm}>
          {!running ? (
            <Button
              label={elapsed > 0 ? 'Resume' : 'Start workout'}
              onPress={() => setRunning(true)}
            />
          ) : (
            <Button label="Pause" variant="secondary" onPress={() => setRunning(false)} />
          )}

          {steps.length > 1 && running ? (
            <Button
              label="Next step"
              variant="secondary"
              onPress={() => {
                setStepIndex((index) => Math.min(steps.length - 1, index + 1));
                setStepElapsed(0);
              }}
            />
          ) : null}

          {elapsed > 0 ? (
            <Button label="Finish and log" variant="ghost" onPress={() => void finish()} />
          ) : null}
        </Stack>

        {/* Honest about what this screen does and does not measure. */}
        <Card>
          <Type variant="caption" tone="tertiary">
            This timer guides the session. Pace, distance and heart rate are imported from Strava or
            Apple Health after your run, so nothing shown here is estimated.
          </Type>
        </Card>

        {/* Full session */}
        <View>
          <SectionHeader title="Session" />
          <Card>
            <Stack gap={spacing.sm}>
              {steps.map((step, index) => (
                <React.Fragment key={`${step.id}-${index}`}>
                  {index > 0 ? <Divider /> : null}
                  <Stack
                    direction="row"
                    justify="space-between"
                    align="center"
                    style={{ minHeight: 40, opacity: index === stepIndex ? 1 : 0.55 }}
                  >
                    <Stack gap={2} style={{ flex: 1 }}>
                      <Type variant="body">
                        {step.label}
                        {step.repetitionLabel ? ` · ${step.repetitionLabel}` : ''}
                      </Type>
                    </Stack>
                    {index === stepIndex ? <Chip label="Now" tone="accent" selected /> : null}
                    <Type variant="caption" tone="tertiary">
                      {step.durationSeconds
                        ? formatDuration(step.durationSeconds)
                        : step.distanceMeters
                          ? formatDistance(step.distanceMeters)
                          : ''}
                    </Type>
                  </Stack>
                </React.Fragment>
              ))}
            </Stack>
          </Card>
        </View>

        {/* Zones for reference, in whichever methodology the athlete chose. */}
        {dashboard.data?.zones ? (
          <View>
            <SectionHeader title={`Heart-rate zones · ${dashboard.data.zones.methodology.replace(/_/g, ' ')}`} />
            <Card>
              <Stack gap={spacing.sm}>
                {dashboard.data.zones.zones.map((zone) => (
                  <Stack key={zone.number} direction="row" justify="space-between" align="center">
                    <Stack direction="row" gap={spacing.sm} align="center">
                      <View
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 4,
                          backgroundColor: theme.color.zones[zone.number - 1] ?? theme.color.border,
                        }}
                      />
                      <Type variant="body">
                        Z{zone.number} {zone.name}
                      </Type>
                    </Stack>
                    <Type variant="caption" tone="tertiary">
                      {zone.lowerBound}
                      {zone.upperBound > 0 ? `–${zone.upperBound}` : '+'} bpm
                    </Type>
                  </Stack>
                ))}
                {dashboard.data.zones.note ? (
                  <Type variant="caption" tone="tertiary">
                    {dashboard.data.zones.note}
                  </Type>
                ) : null}
              </Stack>
            </Card>
          </View>
        ) : null}
      </Stack>
    </Screen>
  );
}
