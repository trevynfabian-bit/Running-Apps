/**
 * Trend chart for one composition metric.
 *
 * One metric, one axis. Circumference is centimetres, weight kilograms and body
 * fat a percentage; any two of them on one plot would need two y-scales, and
 * the alignment between two arbitrary scales invents a correlation that is not
 * in the data. The metric picker above this chart is what keeps it honest, not
 * a convenience.
 *
 * A single series carries no legend — the title names it. Values are not
 * printed on every point either; the axis labels carry the scale and tapping a
 * point reads out the one the athlete is actually asking about.
 *
 * Body fat renders as a filled band rather than a line, matching how it is
 * shown everywhere else: the method's error is wide enough that a single trace
 * would imply precision the estimate does not have.
 *
 * The numbers behind this chart are not chart-only — the comparison rows and
 * the per-metric history list show them as text, so nothing here is the sole
 * route to the data.
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { trendExtent, trendLength, type TrendSeries } from '../lib/composition-trends';
import { radius, spacing } from '../design/tokens';
import { useTheme } from '../design/theme';
import { Stack, Type } from './primitives';

const HEIGHT = 168;
/** Room for the value labels sitting against the plot. */
const PAD = { top: 10, bottom: 22, left: 0, right: 0 } as const;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function TrendChart({ series }: { series: TrendSeries }): React.ReactElement {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<number>();

  const count = trendLength(series);

  if (count < 2) {
    return (
      <View style={{ height: HEIGHT, justifyContent: 'center' }}>
        <Type variant="caption" tone="tertiary">
          {count === 0
            ? 'Nothing recorded for this metric yet.'
            : 'One reading so far. A second one makes a trend.'}
        </Type>
      </View>
    );
  }

  const { min, max } = trendExtent(series);
  const span = max - min;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;

  const x = (index: number): number => (index / (count - 1)) * width;
  const y = (value: number): number => PAD.top + plotHeight - ((value - min) / span) * plotHeight;

  const dates = series.band
    ? series.band.map((entry) => entry.capturedAt)
    : (series.points ?? []).map((entry) => entry.capturedAt);

  const line = (values: readonly number[]): string =>
    values
      .map(
        (value, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(value).toFixed(1)}`,
      )
      .join(' ');

  /** Closed path around a band: along the highs, back along the lows. */
  const bandPath = (): string => {
    const band = series.band ?? [];
    const top = band.map((entry) => entry.high);
    const bottom = [...band].reverse().map((entry) => entry.low);
    const forward = line(top);
    const back = bottom
      .map((value, index) => `L${x(band.length - 1 - index).toFixed(1)},${y(value).toFixed(1)}`)
      .join(' ');
    return `${forward} ${back} Z`;
  };

  const readout = (() => {
    if (selected === undefined) return undefined;
    if (series.band) {
      const entry = series.band[selected];
      return entry
        ? `${formatDate(entry.capturedAt)} · ${entry.low.toFixed(1)}–${entry.high.toFixed(1)}${series.unit}`
        : undefined;
    }
    const entry = series.points?.[selected];
    return entry
      ? `${formatDate(entry.capturedAt)} · ${entry.value.toFixed(1)} ${series.unit}`
      : undefined;
  })();

  const summary = series.band
    ? `${series.label}, ${count} readings, from ${Math.min(...series.band.map((e) => e.low)).toFixed(1)} to ${Math.max(...series.band.map((e) => e.high)).toFixed(1)} ${series.unit}`
    : `${series.label}, ${count} readings, from ${Math.min(...(series.points ?? []).map((e) => e.value)).toFixed(1)} to ${Math.max(...(series.points ?? []).map((e) => e.value)).toFixed(1)} ${series.unit}`;

  return (
    <Stack gap={spacing.sm}>
      <Stack direction="row" justify="space-between" align="center">
        {/* The title names the single series, so there is no legend to read. */}
        <Type variant="bodyStrong">{series.label}</Type>
        <Type variant="caption" tone="tertiary">
          {max.toFixed(1)} / {min.toFixed(1)} {series.unit}
        </Type>
      </Stack>

      <View
        style={{ height: HEIGHT }}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        accessibilityRole="image"
        accessibilityLabel={summary}
      >
        {width > 0 ? (
          <>
            <Svg width={width} height={HEIGHT}>
              {/* Solid hairline baseline, one shade off the surface. A dashed
                  rule would read as a threshold when it is only a grid. */}
              <Line
                x1={0}
                y1={PAD.top + plotHeight}
                x2={width}
                y2={PAD.top + plotHeight}
                stroke={theme.color.border}
                strokeWidth={StyleSheet.hairlineWidth}
              />

              {series.band ? (
                <>
                  <Path d={bandPath()} fill={theme.color.accent} fillOpacity={0.18} />
                  <Path
                    d={line(series.band.map((entry) => entry.high))}
                    stroke={theme.color.accent}
                    strokeWidth={2}
                    fill="none"
                    strokeLinejoin="round"
                  />
                  <Path
                    d={line(series.band.map((entry) => entry.low))}
                    stroke={theme.color.accent}
                    strokeWidth={2}
                    fill="none"
                    strokeLinejoin="round"
                  />
                </>
              ) : (
                <>
                  <Path
                    d={line((series.points ?? []).map((entry) => entry.value))}
                    stroke={theme.color.accent}
                    strokeWidth={2}
                    fill="none"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  {(series.points ?? []).map((entry, index) => (
                    <Circle
                      key={entry.capturedAt}
                      cx={x(index)}
                      cy={y(entry.value)}
                      r={index === selected ? 6 : 4}
                      fill={theme.color.accent}
                      // A surface ring separates a marker from the line it
                      // sits on without drawing a border around it.
                      stroke={theme.color.surface}
                      strokeWidth={2}
                    />
                  ))}
                </>
              )}
            </Svg>

            {/* Touch targets are the full column height, well beyond the
                marker, so a point is easy to hit on a small chart. */}
            <View style={{ position: 'absolute', inset: 0, flexDirection: 'row' }}>
              {dates.map((iso, index) => (
                <Pressable
                  key={iso}
                  onPress={() => setSelected(index === selected ? undefined : index)}
                  accessibilityRole="button"
                  accessibilityLabel={`Reading ${index + 1} of ${count}, ${formatDate(iso)}`}
                  style={{ flex: 1 }}
                />
              ))}
            </View>
          </>
        ) : null}
      </View>

      <Stack direction="row" justify="space-between">
        <Type variant="caption" tone="tertiary">
          {formatDate(dates[0]!)}
        </Type>
        <Type variant="caption" tone="tertiary">
          {formatDate(dates[dates.length - 1]!)}
        </Type>
      </Stack>

      <View
        style={{
          minHeight: 32,
          justifyContent: 'center',
          paddingHorizontal: spacing.md,
          borderRadius: radius.sm,
          backgroundColor: readout ? theme.color.surfaceRaised : 'transparent',
        }}
      >
        <Type variant="caption" tone={readout ? 'default' : 'tertiary'}>
          {readout ?? 'Tap the chart to read a single session.'}
        </Type>
      </View>
    </Stack>
  );
}
