/**
 * Theme context and typed style helpers.
 */

import React, { createContext, useContext, useMemo } from 'react';
import { useColorScheme, type TextStyle } from 'react-native';

import { darkTheme, lightTheme, typography, type Theme } from './tokens';

const ThemeContext = createContext<Theme>(darkTheme);

export function ThemeProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const scheme = useColorScheme();
  const theme = useMemo(() => (scheme === 'light' ? lightTheme : darkTheme), [scheme]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

export type TypographyVariant = keyof typeof typography;

/**
 * Resolve a type variant into a style object.
 *
 * `fontVariant: ['tabular-nums']` is applied to metric variants so digits
 * occupy equal width — without it, a readiness score animating from 78 to 81
 * visibly shifts the layout around it.
 */
export function typeStyle(variant: TypographyVariant): TextStyle {
  const base = typography[variant];
  const isMetric = variant.startsWith('metric');
  return {
    ...base,
    ...(isMetric ? { fontVariant: ['tabular-nums' as const] } : {}),
  };
}
