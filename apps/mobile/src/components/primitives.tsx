/**
 * Design-system primitives.
 *
 * These exist so screens compose rather than restyle. Every one is
 * accessibility-aware by construction: text scales with the system setting,
 * touch targets meet the 44pt minimum, and anything conveying status carries
 * a label rather than relying on colour alone.
 */

import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type RefreshControlProps,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { radius, spacing } from '../design/tokens';
import { typeStyle, useTheme, type TypographyVariant } from '../design/theme';

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export interface TypeProps {
  variant?: TypographyVariant;
  tone?: 'default' | 'secondary' | 'tertiary' | 'accent' | 'positive' | 'caution' | 'negative';
  style?: StyleProp<TextStyle>;
  children: React.ReactNode;
  numberOfLines?: number;
  accessibilityRole?: 'header' | 'text';
}

export function Type({
  variant = 'body',
  tone = 'default',
  style,
  children,
  numberOfLines,
  accessibilityRole,
}: TypeProps): React.ReactElement {
  const theme = useTheme();

  const color = {
    default: theme.color.text,
    secondary: theme.color.textSecondary,
    tertiary: theme.color.textTertiary,
    accent: theme.color.accent,
    positive: theme.color.positive,
    caution: theme.color.caution,
    negative: theme.color.negative,
  }[tone];

  return (
    <Text
      style={[typeStyle(variant), { color }, style]}
      numberOfLines={numberOfLines}
      accessibilityRole={accessibilityRole}
      // Respect the system text size, but stop runaway scaling from breaking
      // metric layouts entirely.
      maxFontSizeMultiplier={variant.startsWith('metric') ? 1.5 : 2}
    >
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Screen({
  children,
  scroll = true,
  refreshControl,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  refreshControl?: React.ReactElement<RefreshControlProps>;
}): React.ReactElement {
  const theme = useTheme();
  const style = { flex: 1, backgroundColor: theme.color.background };

  if (!scroll) return <View style={style}>{children}</View>;

  return (
    <ScrollView
      style={style}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxxl * 2 }}
      refreshControl={refreshControl}
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  );
}

export function Card({
  children,
  style,
  onPress,
  accessibilityLabel,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  accessibilityLabel?: string;
}): React.ReactElement {
  const theme = useTheme();

  const content = (
    <View
      style={[
        {
          backgroundColor: theme.color.surface,
          borderRadius: radius.lg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.color.border,
          padding: spacing.lg,
        },
        style,
      ]}
    >
      {children}
    </View>
  );

  if (!onPress) return content;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}
    >
      {content}
    </Pressable>
  );
}

export function Stack({
  children,
  gap = spacing.md,
  direction = 'column',
  align,
  justify,
  style,
}: {
  children: React.ReactNode;
  gap?: number;
  direction?: 'row' | 'column';
  align?: ViewStyle['alignItems'];
  justify?: ViewStyle['justifyContent'];
  style?: StyleProp<ViewStyle>;
}): React.ReactElement {
  return (
    <View
      style={[{ flexDirection: direction, gap, alignItems: align, justifyContent: justify }, style]}
    >
      {children}
    </View>
  );
}

export function Divider(): React.ReactElement {
  const theme = useTheme();
  return (
    <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.color.border }} />
  );
}

export function SectionHeader({
  title,
  action,
}: {
  title: string;
  action?: { label: string; onPress: () => void };
}): React.ReactElement {
  return (
    <Stack direction="row" justify="space-between" align="center" style={{ marginBottom: spacing.md }}>
      <Type variant="overline" tone="tertiary" accessibilityRole="header">
        {title.toUpperCase()}
      </Type>
      {action ? (
        <Pressable
          onPress={action.onPress}
          accessibilityRole="button"
          hitSlop={12}
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <Type variant="caption" tone="accent">
            {action.label}
          </Type>
        </Pressable>
      ) : null}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}): React.ReactElement {
  const theme = useTheme();

  const background = {
    primary: theme.color.accent,
    secondary: theme.color.surfaceRaised,
    ghost: 'transparent',
    danger: theme.color.negative,
  }[variant];

  const textTone: TypeProps['tone'] =
    variant === 'primary' || variant === 'danger' ? 'default' : variant === 'ghost' ? 'accent' : 'default';

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      style={({ pressed }) => [
        {
          backgroundColor: background,
          borderRadius: radius.md,
          // 48 clears the 44pt minimum touch target with room for focus rings.
          minHeight: 48,
          paddingHorizontal: spacing.lg,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: variant === 'secondary' ? StyleSheet.hairlineWidth : 0,
          borderColor: theme.color.borderStrong,
          opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? '#fff' : theme.color.accent} />
      ) : (
        <Type
          variant="bodyStrong"
          tone={textTone}
          style={variant === 'primary' || variant === 'danger' ? { color: '#fff' } : undefined}
        >
          {label}
        </Type>
      )}
    </Pressable>
  );
}

export function Chip({
  label,
  tone = 'neutral',
  selected,
  onPress,
}: {
  label: string;
  tone?: 'neutral' | 'positive' | 'caution' | 'negative' | 'accent';
  selected?: boolean;
  onPress?: () => void;
}): React.ReactElement {
  const theme = useTheme();

  const color = {
    neutral: theme.color.textSecondary,
    positive: theme.color.positive,
    caution: theme.color.caution,
    negative: theme.color.negative,
    accent: theme.color.accent,
  }[tone];

  const body = (
    <View
      style={{
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs + 2,
        borderRadius: radius.pill,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: selected ? color : theme.color.border,
        backgroundColor: selected ? `${color}22` : 'transparent',
        minHeight: 32,
        justifyContent: 'center',
      }}
    >
      <Type variant="caption" style={{ color }}>
        {label}
      </Type>
    </View>
  );

  if (!onPress) return body;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      hitSlop={8}
    >
      {body}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { label: string; onPress: () => void };
}): React.ReactElement {
  return (
    <Card style={{ alignItems: 'center', paddingVertical: spacing.xxl }}>
      <Stack gap={spacing.sm} align="center">
        <Type variant="heading">{title}</Type>
        <Type variant="body" tone="secondary" style={{ textAlign: 'center' }}>
          {body}
        </Type>
        {action ? (
          <Button
            label={action.label}
            onPress={action.onPress}
            variant="secondary"
            style={{ marginTop: spacing.md, alignSelf: 'stretch' }}
          />
        ) : null}
      </Stack>
    </Card>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}): React.ReactElement {
  return (
    <Card>
      <Stack gap={spacing.md}>
        <Type variant="bodyStrong" tone="negative">
          Something went wrong
        </Type>
        {/* The message comes from the API's athlete-facing error envelope,
            never from a raw exception. */}
        <Type variant="body" tone="secondary">
          {message}
        </Type>
        {onRetry ? <Button label="Try again" onPress={onRetry} variant="secondary" /> : null}
      </Stack>
    </Card>
  );
}

export function LoadingState({ label = 'Loading' }: { label?: string }): React.ReactElement {
  const theme = useTheme();
  return (
    <View
      style={{ paddingVertical: spacing.xxl, alignItems: 'center', gap: spacing.md }}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
    >
      <ActivityIndicator color={theme.color.accent} />
      <Type variant="caption" tone="tertiary">
        {label}
      </Type>
    </View>
  );
}
