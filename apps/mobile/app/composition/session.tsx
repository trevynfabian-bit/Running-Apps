/**
 * Four-angle body composition capture.
 *
 * Three steps: read the framing guidance, photograph the four angles, check
 * them side by side. The athlete is standing in front of a camera, often half
 * dressed, so the flow asks for one angle at a time and keeps every decision
 * off that screen except "take it" and "use the one I have".
 *
 * Order is suggested, not enforced. The flow offers the first outstanding angle
 * and moves to the next one after each shot, but the strip along the bottom
 * jumps to any side — someone who fumbled the back shot should not have to
 * walk through the other three to fix it.
 *
 * Nothing is saved yet. Capture resolves through the stub in
 * `lib/composition-capture`, and the session has nowhere to go until the
 * composition API exists; both are separate pieces of work and both are the
 * only things standing between this flow and a real session.
 */

import React, { useState } from 'react';
import { Alert, View } from 'react-native';
import { router } from 'expo-router';

import {
  COMPOSITION_SIDES,
  COMPOSITION_SIDE_LABELS,
  captureProgress,
  capturedSides,
  createSessionDraft,
  isSessionComplete,
  nextSideToCapture,
  photoForSide,
  putPhoto,
  type CompositionSide,
} from '@running/core';

import {
  CAPTURE_SOURCES,
  capturePhoto,
  type CaptureMethod,
} from '../../src/lib/composition-capture';
import { spacing } from '../../src/design/tokens';
import { Button, Card, Screen, SectionHeader, Stack, Type } from '../../src/components/primitives';
import {
  CaptureProgress,
  SessionSetupGuide,
  SideGuidanceCard,
  SidePhotoPreview,
  SidePhotoTile,
  describeCapture,
} from '../../src/components/composition';

type Step = 'guide' | 'capture' | 'review';

/** The steps the guidance can be opened from, and returned to. */
type CaptureStep = Exclude<Step, 'guide'>;

/**
 * The review grid, two by two.
 *
 * Front against back and left against right: those are the pairs the eye
 * compares, so each pair shares a row.
 */
const REVIEW_ROWS: readonly (readonly CompositionSide[])[] = [
  ['front', 'back'],
  ['left', 'right'],
];

export default function CompositionSessionScreen(): React.ReactElement {
  const [step, setStep] = useState<Step>('guide');
  const [draft, setDraft] = useState(() => createSessionDraft(new Date()));
  const [activeSide, setActiveSide] = useState<CompositionSide>('front');
  const [busy, setBusy] = useState<CaptureMethod>();
  // Set only while the guidance is being re-read mid-session. Its presence is
  // what tells the guide step it is a detour rather than the way in.
  const [guideReturn, setGuideReturn] = useState<CaptureStep>();
  // Cleared by the next attempt, so a refused permission does not sit under a
  // shot that has since succeeded.
  const [captureError, setCaptureError] = useState<string>();
  // The angle being looked at full size, if any. Separate from `activeSide`:
  // inspecting an angle is not the same as deciding to reshoot it.
  const [previewSide, setPreviewSide] = useState<CompositionSide>();

  const progress = captureProgress(draft);
  const taken = capturedSides(draft);
  const activePhoto = photoForSide(draft, activeSide);

  const openCapture = (side: CompositionSide): void => {
    setActiveSide(side);
    setCaptureError(undefined);
    setStep('capture');
  };

  /**
   * Re-read the guidance mid-session.
   *
   * Nothing is reset on the way in or out. The draft, the angle being worked
   * on and the step to come back to all survive, because someone checking how
   * far back to stand is asking a question, not starting over.
   */
  const openGuide = (from: CaptureStep): void => {
    setGuideReturn(from);
    setStep('guide');
  };

  const closeGuide = (): void => {
    setStep(guideReturn ?? 'capture');
    setGuideReturn(undefined);
  };

  const stepPreview = (delta: -1 | 1): void => {
    if (!previewSide) return;
    const next = COMPOSITION_SIDES[COMPOSITION_SIDES.indexOf(previewSide) + delta];
    if (next) setPreviewSide(next);
  };

  const retakeFromPreview = (): void => {
    if (!previewSide) return;
    const side = previewSide;
    setPreviewSide(undefined);
    openCapture(side);
  };

  const take = async (method: CaptureMethod): Promise<void> => {
    setBusy(method);
    setCaptureError(undefined);
    try {
      const outcome = await capturePhoto(activeSide, method);

      // Backing out of the picker means "stay on this angle", not an error.
      if (outcome.status === 'cancelled') return;

      if (outcome.status !== 'captured') {
        // One source failing says nothing about the other, so the choice stays
        // on screen and the athlete can take the photo the other way.
        setCaptureError(outcome.message);
        return;
      }

      const next = putPhoto(draft, { side: activeSide, uri: outcome.uri, capturedAt: new Date() });
      setDraft(next);

      // Move the athlete along rather than leaving them on a shot they just
      // took: the next gap, or the review once there are none.
      const remaining = nextSideToCapture(next);
      if (remaining) setActiveSide(remaining);
      else setStep('review');
    } finally {
      setBusy(undefined);
    }
  };

  const leave = (): void => {
    if (draft.photos.length === 0) {
      router.back();
      return;
    }
    Alert.alert('Discard this session?', 'The angles you have taken will not be kept.', [
      { text: 'Keep capturing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => router.back() },
    ]);
  };

  const finish = (): void => {
    // Honest about where this stops. Saving needs the composition endpoint, and
    // measurements are the next screen in the session once it exists.
    Alert.alert(
      'All four angles captured',
      'Saving the session and recording your measurements arrive with the composition API.',
      [{ text: 'Done', onPress: () => router.back() }],
    );
  };

  return (
    <Screen>
      <Stack gap={spacing.xl}>
        {step === 'guide' ? (
          <Stack gap={spacing.lg}>
            <Stack gap={spacing.xs}>
              <Type variant="title">Four angles, same way each time</Type>
              <Type variant="body" tone="secondary">
                These photos are only worth taking if they can be compared. Over the weeks where a
                real change is a couple of centimetres, how you set the shot up matters more than it
                sounds like it should.
              </Type>
              {guideReturn && progress.captured > 0 ? (
                <Type variant="caption" tone="tertiary">
                  {progress.captured} of {progress.total} angles are already taken. Reading this
                  does not change them.
                </Type>
              ) : null}
            </Stack>

            <Stack>
              <SectionHeader title={guideReturn ? 'Setting up' : 'Before you start'} />
              <SessionSetupGuide />
            </Stack>

            <Stack>
              <SectionHeader title="The four angles" />
              <Stack gap={spacing.sm}>
                {COMPOSITION_SIDES.map((side) => (
                  <SideGuidanceCard key={side} side={side} />
                ))}
              </Stack>
            </Stack>

            <Card>
              <Type variant="caption" tone="tertiary">
                Photos stay on your device until you save the session.
              </Type>
            </Card>

            {/* A detour offers only the way back. Discarding is not something to
                put in front of someone who came here to re-read an instruction. */}
            {guideReturn ? (
              <Button
                label={guideReturn === 'review' ? 'Back to review' : 'Back to capturing'}
                onPress={closeGuide}
              />
            ) : (
              <Stack gap={spacing.sm}>
                <Button
                  label="Start capturing"
                  onPress={() => openCapture(nextSideToCapture(draft) ?? 'front')}
                />
                <Button label="Not now" variant="ghost" onPress={leave} />
              </Stack>
            )}
          </Stack>
        ) : null}

        {step === 'capture' ? (
          <Stack gap={spacing.lg}>
            <Stack gap={spacing.xs}>
              <Type variant="overline" tone="tertiary">
                ANGLE {COMPOSITION_SIDES.indexOf(activeSide) + 1} OF {COMPOSITION_SIDES.length}
              </Type>
              <Type variant="title">{COMPOSITION_SIDE_LABELS[activeSide]}</Type>
            </Stack>

            <Stack>
              <SectionHeader
                title="Framing"
                action={{ label: 'Full guide', onPress: () => openGuide('capture') }}
              />
              <SideGuidanceCard side={activeSide} compact />
            </Stack>

            <CaptureProgress
              captured={progress.captured}
              total={progress.total}
              sides={COMPOSITION_SIDES}
              capturedSides={taken}
            />

            {/* Held to a single column so the framing is big enough to judge. */}
            <View style={{ flexDirection: 'row' }}>
              <SidePhotoTile side={activeSide} photo={activePhoto} />
            </View>

            {/* Both sources stay on screen at all times. Which one is right
                depends on whether the athlete is alone, and that changes
                between angles, not between sessions. */}
            <Stack gap={spacing.md}>
              {CAPTURE_SOURCES.map((source, index) => (
                <Stack key={source.method} gap={spacing.xs}>
                  <Button
                    label={activePhoto ? source.retakeLabel : source.label}
                    variant={index === 0 ? 'primary' : 'secondary'}
                    onPress={() => void take(source.method)}
                    loading={busy === source.method}
                    disabled={busy !== undefined}
                  />
                  <Type variant="caption" tone="tertiary" style={{ textAlign: 'center' }}>
                    {source.hint}
                  </Type>
                </Stack>
              ))}

              {captureError ? (
                <Type variant="caption" tone="negative">
                  {captureError}
                </Type>
              ) : null}

              {isSessionComplete(draft) ? (
                <Button label="Review all four" variant="ghost" onPress={() => setStep('review')} />
              ) : null}
            </Stack>

            <Stack>
              <SectionHeader title="This session" />
              <Stack direction="row" gap={spacing.sm}>
                {COMPOSITION_SIDES.map((side) => {
                  const photo = photoForSide(draft, side);
                  return (
                    <SidePhotoTile
                      key={side}
                      side={side}
                      photo={photo}
                      caption={photo ? describeCapture(photo) : undefined}
                      onPress={() => setActiveSide(side)}
                    />
                  );
                })}
              </Stack>
            </Stack>
          </Stack>
        ) : null}

        {step === 'review' ? (
          <Stack gap={spacing.lg}>
            <Stack gap={spacing.xs}>
              <Type variant="title">Check them before you save</Type>
              <Type variant="body" tone="secondary">
                Tap an angle to see it full size. At this size a soft or badly framed shot still
                looks fine.
              </Type>
            </Stack>

            <CaptureProgress
              captured={progress.captured}
              total={progress.total}
              sides={COMPOSITION_SIDES}
              capturedSides={taken}
            />

            <SectionHeader
              title="Your four angles"
              action={{ label: 'Full guide', onPress: () => openGuide('review') }}
            />

            <Stack gap={spacing.sm}>
              {REVIEW_ROWS.map((row) => (
                <Stack key={row.join('-')} direction="row" gap={spacing.sm}>
                  {row.map((side) => {
                    const photo = photoForSide(draft, side);
                    return (
                      <SidePhotoTile
                        key={side}
                        side={side}
                        photo={photo}
                        caption={photo ? describeCapture(photo) : 'Not taken yet'}
                        onPress={() => setPreviewSide(side)}
                      />
                    );
                  })}
                </Stack>
              ))}
            </Stack>

            <Stack gap={spacing.sm}>
              <Button
                label={isSessionComplete(draft) ? 'Save session' : 'Capture the rest'}
                onPress={
                  isSessionComplete(draft)
                    ? finish
                    : () => openCapture(nextSideToCapture(draft) ?? 'front')
                }
              />
              <Button label="Discard" variant="ghost" onPress={leave} />
            </Stack>
          </Stack>
        ) : null}
      </Stack>

      {previewSide ? (
        <SidePhotoPreview
          visible
          side={previewSide}
          photo={photoForSide(draft, previewSide)}
          onClose={() => setPreviewSide(undefined)}
          onRetake={retakeFromPreview}
          onStep={stepPreview}
        />
      ) : null}
    </Screen>
  );
}
