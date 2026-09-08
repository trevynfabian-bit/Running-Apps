import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { ThemeProvider, useTheme } from '../src/design/theme';
import { SessionProvider, useSession } from '../src/lib/session';
import { LoadingState, Screen } from '../src/components/primitives';

/**
 * Routing gate.
 *
 * Three states, resolved before anything renders: still checking the stored
 * token, signed out, or signed in. Onboarding is a separate stack rather than
 * a modal so an athlete cannot swipe past it into an app with no plan.
 */
function RootNavigator(): React.ReactElement {
  const theme = useTheme();
  const { status, hasCompletedOnboarding } = useSession();

  if (status === 'loading') {
    return (
      <Screen scroll={false}>
        <LoadingState label="Loading your training" />
      </Screen>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.color.background },
        headerTintColor: theme.color.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: theme.color.background },
      }}
    >
      <Stack.Protected guard={status === 'signed_out'}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      </Stack.Protected>

      <Stack.Protected guard={status === 'signed_in' && !hasCompletedOnboarding}>
        <Stack.Screen name="onboarding" options={{ headerShown: false }} />
      </Stack.Protected>

      <Stack.Protected guard={status === 'signed_in' && hasCompletedOnboarding}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="connections" options={{ title: 'Connected data' }} />
        <Stack.Screen name="workout/[id]" options={{ title: 'Workout' }} />
        <Stack.Screen name="body-composition/index" options={{ title: 'Body composition' }} />
        <Stack.Screen
          name="why"
          options={{ presentation: 'modal', title: 'Why this recommendation?' }}
        />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout(): React.ReactElement {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <SessionProvider>
            <StatusBar style="auto" />
            <RootNavigator />
          </SessionProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
