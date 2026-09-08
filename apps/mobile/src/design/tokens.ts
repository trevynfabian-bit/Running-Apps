/**
 * Design tokens.
 *
 * The visual language is built for a performance instrument, not a
 * consumer dashboard: near-black grounds, restrained colour, and typography
 * doing most of the hierarchy work. Colour is reserved for meaning — a red
 * readiness badge must be the most saturated thing on the screen, which only
 * works if nothing else competes with it.
 *
 * Numbers are set in a tabular style so digits don't jitter as values change,
 * which matters on a screen an athlete reads mid-run.
 */

export const palette = {
  // Neutral ramp, cool-shifted so the accent colours read as warm against it.
  ink900: '#07090C',
  ink850: '#0B0E13',
  ink800: '#11151C',
  ink700: '#191F28',
  ink600: '#232B37',
  ink500: '#39434F',
  ink400: '#5C6675',
  ink300: '#8A93A2',
  ink200: '#B6BDC8',
  ink100: '#DDE2E9',
  ink50: '#F2F4F7',
  white: '#FFFFFF',

  // Status colours. Deliberately desaturated relative to typical "traffic
  // light" palettes so they read as data rather than alarm.
  green600: '#1F7A4C',
  green500: '#28A06A',
  green400: '#4CC38A',
  amber600: '#9A6510',
  amber500: '#C98A16',
  amber400: '#E8B339',
  red600: '#A3352C',
  red500: '#CE4A3E',
  red400: '#E97567',

  // Single accent, used for the athlete's own progress and nothing else.
  accent600: '#2C5FD6',
  accent500: '#3D77F0',
  accent400: '#6E9BF7',
} as const;

export interface Theme {
  scheme: 'light' | 'dark';
  color: {
    background: string;
    surface: string;
    surfaceRaised: string;
    border: string;
    borderStrong: string;
    text: string;
    textSecondary: string;
    textTertiary: string;
    accent: string;
    accentMuted: string;
    positive: string;
    caution: string;
    negative: string;
    /** Zone ramp, index 0 = zone 1. */
    zones: readonly string[];
  };
}

export const darkTheme: Theme = {
  scheme: 'dark',
  color: {
    background: palette.ink900,
    surface: palette.ink850,
    surfaceRaised: palette.ink800,
    border: palette.ink700,
    borderStrong: palette.ink600,
    text: palette.ink50,
    textSecondary: palette.ink300,
    textTertiary: palette.ink400,
    accent: palette.accent500,
    accentMuted: palette.accent600,
    positive: palette.green400,
    caution: palette.amber400,
    negative: palette.red400,
    zones: [palette.ink500, palette.green500, palette.accent500, palette.amber500, palette.red500],
  },
};

export const lightTheme: Theme = {
  scheme: 'light',
  color: {
    background: palette.ink50,
    surface: palette.white,
    surfaceRaised: palette.white,
    border: palette.ink100,
    borderStrong: palette.ink200,
    text: palette.ink900,
    textSecondary: palette.ink400,
    textTertiary: palette.ink300,
    accent: palette.accent600,
    accentMuted: palette.accent400,
    positive: palette.green600,
    caution: palette.amber600,
    negative: palette.red600,
    zones: [palette.ink300, palette.green500, palette.accent500, palette.amber500, palette.red500],
  },
};

/** 4pt base scale. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

/**
 * Type scale.
 *
 * `metric` variants use tabular figures and tight tracking — they are for
 * numbers that update, where character width shifting would be visible.
 */
export const typography = {
  display: { fontSize: 44, lineHeight: 48, fontWeight: '700' as const, letterSpacing: -1.2 },
  metricLarge: { fontSize: 56, lineHeight: 58, fontWeight: '700' as const, letterSpacing: -2 },
  metricMedium: { fontSize: 32, lineHeight: 36, fontWeight: '600' as const, letterSpacing: -0.8 },
  metricSmall: { fontSize: 20, lineHeight: 24, fontWeight: '600' as const, letterSpacing: -0.3 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '600' as const, letterSpacing: -0.5 },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '600' as const, letterSpacing: -0.2 },
  body: { fontSize: 15, lineHeight: 22, fontWeight: '400' as const, letterSpacing: 0 },
  bodyStrong: { fontSize: 15, lineHeight: 22, fontWeight: '600' as const, letterSpacing: 0 },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' as const, letterSpacing: 0 },
  /** All-caps section labels. Tracking opens up to stay legible at size. */
  overline: { fontSize: 11, lineHeight: 14, fontWeight: '600' as const, letterSpacing: 1.1 },
} as const;

/**
 * Elevation.
 *
 * Dark surfaces get separation from a lighter background rather than a shadow,
 * because shadows are nearly invisible on near-black and cost a render pass.
 */
export const elevation = {
  none: {},
  card: {
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
} as const;

/** Duration in ms. Kept short — this is an instrument, not an experience. */
export const motion = {
  fast: 140,
  base: 220,
  slow: 340,
} as const;
