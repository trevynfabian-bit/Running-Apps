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

import { capturePhoto, type CaptureMethod } from '../../src/lib/composition-capture';
import { spacing } from '../../src/design/tokens';
import { Button, Card, Screen, SectionHeader, Stack, Type } from '../../src/components/primitives';
import { CaptureProgress, SidePhotoTile } from '../../src/components/composition';

type Step = 'guide' | 'capture' | 'review';

/**
 * One line per angle, shown while that angle is being framed.
 *
 * Deliberately short. The fuller standing-distance and lighting guidance is its
 * own screen; this is the reminder at the moment of taking the shot.
 */
const FRAMING: Readonly<Record<CompositionSide, string>> = {
  front: 'Face the camera square on. Arms slightly away from your sides.',
  back: 'Turn to face directly away, same stance and same spot.',
  left: 'Quarter turn to your left. Arms relaxed, hanging naturally.',
  right: 'Quarter turn to your right. Arms relaxed, hanging naturally.',
};

export default function CompositionSessionScreen(): React.ReactElement {
  const [step, setStep] = useState<Step>('guide');
  const [draft, setDraft] = useState(() => createSessionDraft(new Date()));
  const [activeSide, setActiveSide] = useState<CompositionSide>('front');
  const [busy, setBusy] = useState<CaptureMethod>();

  const progress = captureProgress(draft);
  const taken = capturedSides(draft);
  const activePhoto = photoForSide(draft, activeSide);

  const openCapture = (side: CompositionSide): void => {
    setActiveSide(side);
    setStep('capture');
  };

  const take = async (method: CaptureMethod): Promise<void> => {
    setBusy(method);
    try {
      const uri = await capturePhoto(activeSide, method);
      // Backing out of the picker means "stay here", not an error to report.
      if (!uri) return;

      const next = putPhoto(draft, { side: activeSide, uri, capturedAt: new Date() });
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
                These photos are only worth taking if they are comparable. Same spot, same distance,
                same light, and the camera held at roughly waist height.
              </Type>
            </Stack>

            <Card>
              <Stack gap={spacing.md}>
                {COMPOSITION_SIDES.map((side) => (
                  <Stack key={side} gap={2}>
                    <Type variant="bodyStrong">{COMPOSITION_SIDE_LABELS[side]}</Type>
                    <Type variant="caption" tone="secondary">
                      {FRAMING[side]}
                    </Type>
                  </Stack>
                ))}
              </Stack>
            </Card>

            <Card>
              <Type variant="caption" tone="tertiary">
                Photos stay on your device until you save the session.
              </Type>
            </Card>

            <Stack gap={spacing.sm}>
              <Button
                label="Start capturing"
                onPress={() => openCapture(nextSideToCapture(draft) ?? 'front')}
              />
              <Button label="Not now" variant="ghost" onPress={leave} />
            </Stack>
          </Stack>
        ) : null}

        {step === 'capture' ? (
          <Stack gap={spacing.lg}>
            <Stack gap={spacing.xs}>
              <Type variant="overline" tone="tertiary">
                ANGLE {COMPOSITION_SIDES.indexOf(activeSide) + 1} OF {COMPOSITION_SIDES.length}
              </Type>
              <Type variant="title">{COMPOSITION_SIDE_LABELS[activeSide]}</Type>
              <Type variant="body" tone="secondary">
                {FRAMING[activeSide]}
              </Type>
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

            <Stack gap={spacing.sm}>
              <Button
                label={activePhoto ? 'Retake with camera' : 'Take photo'}
                onPress={() => void take('camera')}
                loading={busy === 'camera'}
                disabled={busy !== undefined}
              />
              <Button
                label="Choose from library"
                variant="secondary"
                onPress={() => void take('library')}
                loading={busy === 'library'}
                disabled={busy !== undefined}
              />
              {isSessionComplete(draft) ? (
                <Button label="Review all four" variant="ghost" onPress={() => setStep('review')} />
              ) : null}
            </Stack>

            <Stack>
              <SectionHeader title="This session" />
              <Stack direction="row" gap={spacing.sm}>
                {COMPOSITION_SIDES.map((side) => (
                  <SidePhotoTile
                    key={side}
                    side={side}
                    photo={photoForSide(draft, side)}
                    onPress={() => setActiveSide(side)}
                  />
                ))}
              </Stack>
            </Stack>
          </Stack>
        ) : null}

        {step === 'review' ? (
          <Stack gap={spacing.lg}>
            <Stack gap={spacing.xs}>
              <Type variant="title">Check them before you save</Type>
              <Type variant="body" tone="secondary">
                Tap any angle to retake it. The other three are kept.
              </Type>
            </Stack>

            <CaptureProgress
              captured={progress.captured}
              total={progress.total}
              sides={COMPOSITION_SIDES}
              capturedSides={taken}
            />

            {/* Two by two: the pairs that get compared are front/back and
                left/right, and this puts each pair on one row. */}
            <Stack gap={spacing.sm}>
              <Stack direction="row" gap={spacing.sm}>
                <SidePhotoTile
                  side="front"
                  photo={photoForSide(draft, 'front')}
                  onPress={() => openCapture('front')}
                />
                <SidePhotoTile
                  side="back"
                  photo={photoForSide(draft, 'back')}
                  onPress={() => openCapture('back')}
                />
              </Stack>
              <Stack direction="row" gap={spacing.sm}>
                <SidePhotoTile
                  side="left"
                  photo={photoForSide(draft, 'left')}
                  onPress={() => openCapture('left')}
                />
                <SidePhotoTile
                  side="right"
                  photo={photoForSide(draft, 'right')}
                  onPress={() => openCapture('right')}
                />
              </Stack>
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
    </Screen>
  );
}
