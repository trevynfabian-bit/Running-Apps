/**
 * Framing guidance for a body composition session.
 *
 * The photographs are only evidence if they are repeatable. Almost everything
 * that makes two sessions look different is a setup difference rather than a
 * body difference: a step closer to the camera, a phone held at chest height
 * instead of waist height, a window behind rather than in front. Over the weeks
 * where a real change is a couple of centimetres, those are the larger effect.
 *
 * So the guidance names distances and positions the athlete can actually
 * reproduce, and says why each one matters — an instruction someone understands
 * is one they will still follow in six weeks.
 *
 * Kept as copy in the app rather than in `@running/core`: it is wording shown
 * on a screen, not a rule any calculation depends on.
 */

import type { CompositionSide } from '@running/core';

/** Set up once, before the first angle. */
export interface SessionSetupStep {
  title: string;
  detail: string;
}

export const SESSION_SETUP: readonly SessionSetupStep[] = [
  {
    title: 'Stand about two metres back',
    detail:
      'Far enough that your whole body fits with a hand-width of space above your head and below your feet. Mark the spot with something that will still be there next month.',
  },
  {
    title: 'Camera at waist height',
    detail:
      'Propped on something level rather than held. Shooting from above or below changes your proportions more than several weeks of training will.',
  },
  {
    title: 'Plain wall, light in front of you',
    detail:
      'Face the window rather than standing with your back to it. A shadow falling across you reads as definition that is not there.',
  },
  {
    title: 'Same clothing, same time of day',
    detail:
      'Fitted clothing, ideally in the morning before eating. What you wear and when you shoot move the picture more than your body does week to week.',
  },
];

export interface SideGuidance {
  /** Where to stand and which way to face. */
  stance: string;
  /** What should be in frame once standing there. */
  framing: string;
}

/**
 * Per-angle instructions.
 *
 * The side angles are described by which shoulder points at the camera rather
 * than as "turn left" or "turn right", which is ambiguous the moment the
 * athlete is looking at the phone instead of standing behind it.
 */
export const SIDE_GUIDANCE: Readonly<Record<CompositionSide, SideGuidance>> = {
  front: {
    stance: 'Square to the camera, feet hip-width apart.',
    framing: 'Arms a hand-width clear of your sides, palms facing in. Look straight ahead.',
  },
  back: {
    stance: 'Turn all the way around, same spot, feet in the same place.',
    framing: 'Arms held the same distance out as the front shot. Head level, shoulders relaxed.',
  },
  left: {
    stance: 'Turn a quarter turn, until your left shoulder points at the camera.',
    framing:
      'Arms hanging naturally at your sides, not pushed back. Look straight ahead, not at the camera.',
  },
  right: {
    stance: 'Turn the other way, until your right shoulder points at the camera.',
    framing: 'Same as the left: arms hanging naturally, eyes forward, weight even on both feet.',
  },
};
