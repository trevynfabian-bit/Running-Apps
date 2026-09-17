/**
 * Photo sources for a body composition session.
 *
 * Two ways in: the camera, for the shot being taken now, and the photo
 * library, for one already taken — someone who had a partner photograph them,
 * or who is backfilling a session from last week.
 *
 * STUB — deliberately, and only for now. Neither `expo-camera` nor
 * `expo-image-picker` is in the app's dependencies, and adding either pulls in
 * native modules and a permissions prompt, which is its own piece of work. The
 * flow can be built and clicked through without them, so it is, and this module
 * is the single seam where the real pickers land.
 *
 * What survives the swap is the outcome type. A real picker does not simply
 * return a URI or not: the athlete can cancel, the permission can be refused,
 * the device can have no camera, and the read can fail. Those are four
 * different things to say to someone standing in front of a camera, so they are
 * four different outcomes here rather than one absent value — which is the part
 * of this module the screens are written against, and the part that does not
 * change when the stub goes.
 */

import type { CompositionSide } from '@running/core';

/** How the athlete supplied the photo. */
export type CaptureMethod = 'camera' | 'library';

export interface CaptureSourceOption {
  method: CaptureMethod;
  label: string;
  /** Wording when this side already has a photo. */
  retakeLabel: string;
  hint: string;
}

/**
 * The sources offered, in order.
 *
 * Camera first: it is what most sessions use, and the library is the fallback
 * for a photo that already exists.
 */
export const CAPTURE_SOURCES: readonly CaptureSourceOption[] = [
  {
    method: 'camera',
    label: 'Take photo',
    retakeLabel: 'Retake with camera',
    hint: 'Prop the phone up and use the timer.',
  },
  {
    method: 'library',
    label: 'Choose from library',
    retakeLabel: 'Choose a different photo',
    hint: 'For a shot someone else took, or one from earlier.',
  },
];

export type CaptureOutcome =
  | { status: 'captured'; uri: string }
  /** The athlete backed out. Not an error, and nothing to tell them. */
  | { status: 'cancelled' }
  /** Permission refused. Recoverable, but only in the system settings. */
  | { status: 'denied'; message: string }
  /** No camera, or no library access on this device. */
  | { status: 'unavailable'; message: string }
  | { status: 'failed'; message: string };

const STUB_SCHEME = 'stub-capture:';

/**
 * Ask the athlete for one side's photo from the given source.
 *
 * The stub always succeeds. The other outcomes are reachable only once a real
 * picker is behind this, which is the point: the screens already handle them,
 * so landing the picker is a change to this function and nothing else.
 */
export async function capturePhoto(
  side: CompositionSide,
  method: CaptureMethod,
): Promise<CaptureOutcome> {
  // Stands in for the round trip through the camera or the photo library, so
  // the flow's busy state is exercised rather than skipped over.
  await new Promise((resolve) => setTimeout(resolve, 400));
  return { status: 'captured', uri: `${STUB_SCHEME}//${side}?via=${method}` };
}

/** True when the URI came from the stub above rather than from a real picker. */
export function isStubPhotoUri(uri: string): boolean {
  return uri.startsWith(STUB_SCHEME);
}

/** The source recorded in a stub URI, for the placeholder's caption. */
export function stubCaptureMethod(uri: string): CaptureMethod | undefined {
  if (!isStubPhotoUri(uri)) return undefined;
  return uri.endsWith('=camera') ? 'camera' : uri.endsWith('=library') ? 'library' : undefined;
}
