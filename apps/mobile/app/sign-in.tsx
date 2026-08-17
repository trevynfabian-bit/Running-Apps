import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSession } from '../src/lib/session';
import { radius, spacing } from '../src/design/tokens';
import { useTheme } from '../src/design/theme';
import { Button, Stack, Type } from '../src/components/primitives';

export default function SignInScreen(): React.ReactElement {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { signIn, signUp } = useSession();

  const [mode, setMode] = useState<'sign_in' | 'sign_up'>('sign_in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      if (mode === 'sign_in') await signIn(email.trim(), password);
      else await signUp(email.trim(), password, name.trim() || 'Athlete');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  const field = {
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: theme.color.surface,
    color: theme.color.text,
    borderWidth: 1,
    borderColor: theme.color.border,
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.color.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={{ flex: 1, justifyContent: 'center', padding: spacing.xl, paddingTop: insets.top }}>
        <Stack gap={spacing.xl}>
          <Stack gap={spacing.sm}>
            <Type variant="display">Running OS</Type>
            <Type variant="body" tone="secondary">
              Your training, understood.
            </Type>
          </Stack>

          <Stack gap={spacing.md}>
            {mode === 'sign_up' ? (
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="Your name"
                placeholderTextColor={theme.color.textTertiary}
                accessibilityLabel="Your name"
                style={field}
                autoCapitalize="words"
              />
            ) : null}

            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="Email"
              placeholderTextColor={theme.color.textTertiary}
              accessibilityLabel="Email"
              style={field}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
            />

            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder={mode === 'sign_up' ? 'Password (10+ characters)' : 'Password'}
              placeholderTextColor={theme.color.textTertiary}
              accessibilityLabel="Password"
              style={field}
              secureTextEntry
              // Lets the OS password manager offer a strong password.
              textContentType={mode === 'sign_up' ? 'newPassword' : 'password'}
            />

            {error ? (
              <Type variant="caption" tone="negative">
                {error}
              </Type>
            ) : null}

            <Button
              label={mode === 'sign_in' ? 'Sign in' : 'Create account'}
              onPress={() => void submit()}
              loading={busy}
            />
            <Button
              label={mode === 'sign_in' ? 'Create an account' : 'I already have an account'}
              variant="ghost"
              onPress={() => {
                setMode(mode === 'sign_in' ? 'sign_up' : 'sign_in');
                setError(undefined);
              }}
            />
          </Stack>

          <Type variant="caption" tone="tertiary">
            Your health data is encrypted in transit and at rest. You can disconnect any source and
            delete its data at any time.
          </Type>
        </Stack>
      </View>
    </KeyboardAvoidingView>
  );
}
