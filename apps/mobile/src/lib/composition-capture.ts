/**
 * Photo capture for a body composition session.
 *
 * STUB — deliberately, and only for now. Neither `expo-camera` nor
 * `expo-image-picker` is in the app's dependencies, and adding either pulls in
 * native modules and a permissions prompt, which is its own piece of work. The
 * capture flow can be built and clicked through without them, so it is, and
 * this module is the single seam where the real pickers land later.
 *
 * What a caller may rely on: `capturePhoto` resolves to a URI the athlete
 * chose, or `undefined` if they backed out. That is the same contract
 * `expo-image-picker` offers, so swapping the body of this function is the
 * whole migration — no screen has to change.
 *
 * Stub URIs carry their own scheme so nothing downstream mistakes one for a
 * real file and tries to upload it.
 */

import type { CompositionSide } from '@running/core';

/** How the athlete supplied the photo. */
export type CaptureMethod = 'camera' | 'library';

const STUB_SCHEME = 'stub-capture:';

/**
 * Ask the athlete for one side's photo.
 *
 * Resolves to `undefined` when they cancel, which the flow treats as "stay on
 * this side" rather than as an error.
 */
export async function capturePhoto(
  side: CompositionSide,
  method: CaptureMethod,
): Promise<string | undefined> {
  // Stands in for the round trip through the camera or the photo library, so
  // the flow's busy state is exercised rather than skipped over.
  await new Promise((resolve) => setTimeout(resolve, 400));
  return `${STUB_SCHEME}//${side}?via=${method}`;
}

/** True when the URI came from the stub above rather than from a real picker. */
export function isStubPhotoUri(uri: string): boolean {
  return uri.startsWith(STUB_SCHEME);
}

/** The method recorded in a stub URI, for the placeholder's caption. */
export function stubCaptureMethod(uri: string): CaptureMethod | undefined {
  if (!isStubPhotoUri(uri)) return undefined;
  return uri.endsWith('=camera') ? 'camera' : uri.endsWith('=library') ? 'library' : undefined;
}
