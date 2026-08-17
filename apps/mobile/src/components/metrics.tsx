/**
 * Domain-specific display components.
 *
 * The product rule these encode: surface the metric that changes a decision,
 * and put everything else one tap deeper. A readiness score with a sentence
 * beneath it is more useful than eight physiological numbers side by side.
 */

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path, Line } from 'react-native-svg';

import { radius, spacing } from '../design/tokens';
import { useTheme } from '../design/theme';
import { Card, Stack, Type } from './primitives';

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export function ReadinessRing({
  score,
  band,
  size = 132,
}: {
  score: number;
  band: 'green' | 'yellow' | 'red';
  size?: number;
}): React.ReactElement {
  const theme = useTheme();
  const color = {
    green: theme.color.positive,
    yellow: theme.color.caution,
    red: theme.color.negative,
  }[band];

  const stroke = 10;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const progress = Math.max(0, Math.min(100, score)) / 100;

  return (
    <View
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
      accessibilityRole="image"
      // Colour alone never conveys the state — the label carries it too.
      accessibilityLabel={`Readiness ${Math.round(score)} out of 100, ${
        band === 'green' ? 'good' : band === 'yellow' ? 'moderate' : 'low'
      }`}
    >
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={theme.color.border}
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${circumference * progress} ${circumference}`}
          // Start at 12 o'clock rather than 3.
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <Stack gap={0} align="center">
        <Type variant="metricMedium">{Math.round(score)}</Type>
        <Type variant="overline" tone="tertiary">
          READINESS
        </Type>
      </Stack>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Metric tiles
// ---------------------------------------------------------------------------

export function MetricCard({
  label,
  value,
  unit,
  detail,
  tone,
  onPress,
}: {
  label: string;
  value: string;
  unit?: string;
  detail?: string;
  tone?: 'default' | 'positive' | 'caution' | 'negative';
  onPress?: () => void;
}): React.ReactElement {
  return (
    <Card style={{ flex: 1, minWidth: 140 }} onPress={onPress} accessibilityLabel={`${label}: ${value}${unit ?? ''}`}>
      <Stack gap={spacing.xs}>
        <Type variant="overline" tone="tertiary">
          {label.toUpperCase()}
        </Type>
        <Stack direction="row" gap={spacing.xs} align="baseline">
          <Type variant="metricSmall" tone={tone === 'default' ? 'default' : tone}>
            {value}
          </Type>
          {unit ? (
            <Type variant="caption" tone="tertiary">
              {unit}
            </Type>
          ) : null}
        </Stack>
        {detail ? (
          <Type variant="caption" tone="secondary" numberOfLines={2}>
            {detail}
          </Type>
        ) : null}
      </Stack>
    </Card>
  );
}

/**
 * A trend readout that always shows its confidence.
 *
 * The confidence chip is not decoration: an "improving" arrow drawn from four
 * scattered data points is a different claim from one drawn from twelve tight
 * ones, and the athlete is entitled to tell them apart.
 */
export function TrendRow({
  label,
  value,
  direction,
  change,
  confidence,
}: {
  label: string;
  value: string;
  direction: 'improving' | 'stable' | 'declining' | 'insufficient_data';
  change?: string;
  confidence: 'low' | 'moderate' | 'high';
}): React.ReactElement {
  const theme = useTheme();

  const tone =
    direction === 'improving' ? 'positive' : direction === 'declining' ? 'negative' : 'secondary';
  const arrow =
    direction === 'improving' ? '↑' : direction === 'declining' ? '↓' : direction === 'stable' ? '→' : '';

  return (
    <View
      style={{ paddingVertical: spacing.md }}
      accessibilityLabel={`${label}: ${value}. ${direction.replace('_', ' ')}. Confidence ${confidence}.`}
    >
      <Stack direction="row" justify="space-between" align="center">
        <Stack gap={2} style={{ flex: 1 }}>
          <Type variant="body">{label}</Type>
          {direction === 'insufficient_data' ? (
            <Type variant="caption" tone="tertiary">
              Not enough data yet
            </Type>
          ) : (
            <Stack direction="row" gap={spacing.xs} align="center">
              <Type variant="caption" tone={tone}>
                {arrow} {change ?? direction}
              </Type>
              <View
                style={{
                  paddingHorizontal: 6,
                  paddingVertical: 1,
                  borderRadius: radius.sm,
                  backgroundColor: theme.color.surfaceRaised,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: theme.color.border,
                }}
              >
                <Type variant="caption" tone="tertiary" style={{ fontSize: 11 }}>
                  {confidence} confidence
                </Type>
              </View>
            </Stack>
          )}
        </Stack>
        <Type variant="metricSmall">{value}</Type>
      </Stack>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

/**
 * Minimal line chart. Deliberately unadorned: no gridlines, no axis furniture,
 * no legend. On a phone the shape of the line is the information; everything
 * else is noise competing with it.
 */
export function Sparkline({
  points,
  height = 64,
  tone = 'accent',
}: {
  points: { date: string; value: number }[];
  height?: number;
  tone?: 'accent' | 'positive' | 'negative';
}): React.ReactElement {
  const theme = useTheme();
  const [width, setWidth] = React.useState(0);

  const color = {
    accent: theme.color.accent,
    positive: theme.color.positive,
    negative: theme.color.negative,
  }[tone];

  if (points.length < 2) {
    return (
      <View style={{ height, justifyContent: 'center' }}>
        <Type variant="caption" tone="tertiary">
          Not enough data to chart yet
        </Type>
      </View>
    );
  }

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series would divide by zero; give it a nominal band so it renders
  // as a straight line through the middle rather than vanishing.
  const range = max - min || 1;

  const path = points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * width;
      const y = height - ((point.value - min) / range) * (height - 8) - 4;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <View
      style={{ height }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      accessibilityRole="image"
      accessibilityLabel={`Chart of ${points.length} points, from ${min.toFixed(1)} to ${max.toFixed(1)}`}
    >
      {width > 0 ? (
        <Svg width={width} height={height}>
          <Line
            x1={0}
            y1={height - 4}
            x2={width}
            y2={height - 4}
            stroke={theme.color.border}
            strokeWidth={StyleSheet.hairlineWidth}
          />
          <Path d={path} stroke={color} strokeWidth={2} fill="none" strokeLinejoin="round" />
        </Svg>
      ) : null}
    </View>
  );
}

/** Horizontal bars for weekly volume against target. */
export function ProgressBar({
  value,
  target,
  label,
  tone = 'accent',
}: {
  value: number;
  target: number;
  label?: string;
  tone?: 'accent' | 'positive' | 'caution';
}): React.ReactElement {
  const theme = useTheme();
  const color = {
    accent: theme.color.accent,
    positive: theme.color.positive,
    caution: theme.color.caution,
  }[tone];

  const ratio = target > 0 ? Math.min(1, value / target) : 0;

  return (
    <Stack gap={spacing.xs}>
      {label ? (
        <Type variant="caption" tone="secondary">
          {label}
        </Type>
      ) : null}
      <View
        style={{
          height: 8,
          borderRadius: radius.pill,
          backgroundColor: theme.color.border,
          overflow: 'hidden',
        }}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: Math.round(target), now: Math.round(value) }}
      >
        <View
          style={{ width: `${ratio * 100}%`, height: '100%', backgroundColor: color }}
        />
      </View>
    </Stack>
  );
}

/** Zone distribution bar, used on workout detail. */
export function ZoneBar({
  distribution,
  height = 10,
}: {
  distribution: number[];
  height?: number;
}): React.ReactElement {
  const theme = useTheme();
  const total = distribution.reduce((a, b) => a + b, 0) || 1;

  return (
    <View
      style={{ flexDirection: 'row', height, borderRadius: radius.pill, overflow: 'hidden' }}
      accessibilityLabel={distribution
        .map((share, index) => `Zone ${index + 1}: ${Math.round((share / total) * 100)}%`)
        .join(', ')}
    >
      {distribution.map((share, index) => (
        <View
          key={index}
          style={{
            flex: Math.max(share, 0.001),
            backgroundColor: theme.color.zones[index] ?? theme.color.border,
          }}
        />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Coaching
// ---------------------------------------------------------------------------

/**
 * The coach's message with a "Why?" affordance.
 *
 * Every recommendation the app makes must be able to explain itself, so this
 * component takes the explanation as a required prop rather than an optional
 * one — it is not possible to render a recommendation without one.
 */
export function CoachMessage({
  headline,
  body,
  explanation,
  onWhy,
  tone = 'default',
}: {
  headline: string;
  body?: string;
  explanation: string;
  onWhy: (explanation: string) => void;
  tone?: 'default' | 'caution' | 'negative';
}): React.ReactElement {
  const theme = useTheme();

  const accent =
    tone === 'caution' ? theme.color.caution : tone === 'negative' ? theme.color.negative : theme.color.accent;

  return (
    <Card>
      <Stack gap={spacing.sm}>
        <Stack direction="row" gap={spacing.sm} align="center">
          <View style={{ width: 3, height: 16, borderRadius: 2, backgroundColor: accent }} />
          <Type variant="overline" tone="tertiary">
            COACH
          </Type>
        </Stack>
        <Type variant="bodyStrong">{headline}</Type>
        {body ? (
          <Type variant="body" tone="secondary">
            {body}
          </Type>
        ) : null}
        <Pressable
          onPress={() => onWhy(explanation)}
          accessibilityRole="button"
          accessibilityLabel="Why this recommendation?"
          hitSlop={8}
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <Type variant="caption" tone="accent">
            Why?
          </Type>
        </Pressable>
      </Stack>
    </Card>
  );
}

/** Connection status dot plus label. */
export function StatusDot({
  status,
}: {
  status: 'connected' | 'disconnected' | 'expired' | 'error' | 'syncing';
}): React.ReactElement {
  const theme = useTheme();
  const color = {
    connected: theme.color.positive,
    syncing: theme.color.accent,
    disconnected: theme.color.textTertiary,
    expired: theme.color.caution,
    error: theme.color.negative,
  }[status];

  const label = {
    connected: 'Connected',
    syncing: 'Syncing',
    disconnected: 'Not connected',
    expired: 'Needs reconnecting',
    error: 'Error',
  }[status];

  return (
    <Stack direction="row" gap={spacing.sm} align="center">
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Type variant="caption" tone="secondary">
        {label}
      </Type>
    </Stack>
  );
}
