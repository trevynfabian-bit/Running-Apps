/**
 * Morning check-in.
 *
 * Four taps and a yes/no, targeted at under fifteen seconds. Every design
 * decision here serves that: no free text on the main path, no scrolling, no
 * confirmation step, and the sheet closes itself on submit.
 *
 * The pain question is last and deliberately plain. It is the one answer that
 * overrides everything else in the coaching engine.
 */

import React, { useState } from 'react';
import { Modal, Pressable, View } from 'react-native';

import { api } from '../lib/api';
import { radius, spacing } from '../design/tokens';
import { useTheme } from '../design/theme';
import { Button, Card, Stack, Type } from './primitives';

interface ScaleProps {
  label: string;
  /** Anchors shown under the ends, so "5" is never ambiguous. */
  lowLabel: string;
  highLabel: string;
  value: number;
  onChange: (value: number) => void;
}

function Scale({ label, lowLabel, highLabel, value, onChange }: ScaleProps): React.ReactElement {
  const theme = useTheme();

  return (
    <Stack gap={spacing.sm}>
      <Type variant="bodyStrong">{label}</Type>
      <Stack direction="row" gap={spacing.sm}>
        {[1, 2, 3, 4, 5].map((option) => {
          const selected = value === option;
          return (
            <Pressable
              key={option}
              onPress={() => onChange(option)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`${label}: ${option} out of 5`}
              style={{
                flex: 1,
                // Comfortably above the 44pt minimum, because this is tapped
                // half-asleep at 5am.
                minHeight: 52,
                borderRadius: radius.md,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: selected ? theme.color.accent : theme.color.surfaceRaised,
                borderWidth: 1,
                borderColor: selected ? theme.color.accent : theme.color.border,
              }}
            >
              <Type
                variant="bodyStrong"
                style={{ color: selected ? '#fff' : theme.color.textSecondary }}
              >
                {option}
              </Type>
            </Pressable>
          );
        })}
      </Stack>
      <Stack direction="row" justify="space-between">
        <Type variant="caption" tone="tertiary">
          {lowLabel}
        </Type>
        <Type variant="caption" tone="tertiary">
          {highLabel}
        </Type>
      </Stack>
    </Stack>
  );
}

export function CheckInSheet({
  visible,
  onClose,
  onSubmitted,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmitted: () => void;
}): React.ReactElement {
  const theme = useTheme();

  const [energy, setEnergy] = useState(3);
  const [soreness, setSoreness] = useState(3);
  const [stress, setStress] = useState(3);
  const [motivation, setMotivation] = useState(3);
  const [hasPain, setHasPain] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (): Promise<void> => {
    setSubmitting(true);
    setError(undefined);
    try {
      await api.checkIn({ energy, soreness, stress, motivation, hasPain });
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your check-in.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: theme.color.background, padding: spacing.lg }}>
        <Stack gap={spacing.xl}>
          <Stack gap={spacing.xs}>
            <Type variant="title">How do you feel?</Type>
            <Type variant="body" tone="secondary">
              This tunes today&apos;s session to you.
            </Type>
          </Stack>

          <Scale
            label="Energy"
            lowLabel="Drained"
            highLabel="Fresh"
            value={energy}
            onChange={setEnergy}
          />
          {/* Stored "higher is better" throughout, so 5 always means good. */}
          <Scale
            label="Muscle soreness"
            lowLabel="Very sore"
            highLabel="None"
            value={soreness}
            onChange={setSoreness}
          />
          <Scale
            label="Stress"
            lowLabel="Very stressed"
            highLabel="Calm"
            value={stress}
            onChange={setStress}
          />
          <Scale
            label="Motivation"
            lowLabel="Low"
            highLabel="High"
            value={motivation}
            onChange={setMotivation}
          />

          <Card>
            <Stack direction="row" justify="space-between" align="center">
              <Stack gap={2} style={{ flex: 1 }}>
                <Type variant="bodyStrong">Any pain?</Type>
                <Type variant="caption" tone="secondary">
                  Not normal soreness — pain.
                </Type>
              </Stack>
              <Stack direction="row" gap={spacing.sm}>
                {[
                  { label: 'No', value: false },
                  { label: 'Yes', value: true },
                ].map((option) => {
                  const selected = hasPain === option.value;
                  return (
                    <Pressable
                      key={option.label}
                      onPress={() => setHasPain(option.value)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`Pain: ${option.label}`}
                      style={{
                        minWidth: 60,
                        minHeight: 44,
                        borderRadius: radius.md,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: selected
                          ? option.value
                            ? theme.color.negative
                            : theme.color.accent
                          : theme.color.surfaceRaised,
                        borderWidth: 1,
                        borderColor: selected ? 'transparent' : theme.color.border,
                      }}
                    >
                      <Type
                        variant="bodyStrong"
                        style={{ color: selected ? '#fff' : theme.color.textSecondary }}
                      >
                        {option.label}
                      </Type>
                    </Pressable>
                  );
                })}
              </Stack>
            </Stack>
          </Card>

          {error ? (
            <Type variant="caption" tone="negative">
              {error}
            </Type>
          ) : null}

          <Stack gap={spacing.sm}>
            <Button label="Save" onPress={() => void submit()} loading={submitting} />
            <Button label="Skip for now" variant="ghost" onPress={onClose} />
          </Stack>
        </Stack>
      </View>
    </Modal>
  );
}
