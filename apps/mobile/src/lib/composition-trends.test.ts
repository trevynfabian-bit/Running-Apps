/**
 * The series builder decides what goes on one axis, which is the decision that
 * makes or breaks a chart like this.
 */

import { describe, expect, it } from 'vitest';

import { STUB_CIRCUMFERENCE_POINTS } from './body-composition';
import type { BodyCompositionSession } from './composition-session';
import {
  buildTrendSeries,
  trendExtent,
  trendLength,
  type TrendSources,
} from './composition-trends';

const NOW = new Date('2026-09-20T12:00:00.000Z');
const WAIST = STUB_CIRCUMFERENCE_POINTS.find((point) => point.code === 'waist')!;
const THIGH = STUB_CIRCUMFERENCE_POINTS.find((point) => point.code === 'thigh')!;

function session(id: string, capturedAt: string, waistCm?: number): BodyCompositionSession {
  return {
    id,
    capturedAt,
    measurements:
      waistCm === undefined
        ? []
        : [
            {
              id: `${id}-waist`,
              pointId: WAIST.id,
              valueCm: waistCm,
              recordedUnit: 'cm',
              capturedAt,
            },
          ],
  };
}

const SOURCES: TrendSources = {
  sessions: [
    session('september', '2026-09-06T07:45:00.000Z', 85.3),
    session('june', '2026-06-14T07:30:00.000Z', 88.2),
    session('july', '2026-07-12T07:15:00.000Z', 87.1),
  ],
  weightKg: [
    { capturedAt: '2026-09-06T07:45:00.000Z', value: 72.6 },
    { capturedAt: '2026-06-14T07:30:00.000Z', value: 74.8 },
  ],
  bodyFatPercent: [
    { capturedAt: '2026-09-06T07:45:00.000Z', low: 15.3, high: 22.3 },
    { capturedAt: '2026-06-14T07:30:00.000Z', low: 17.1, high: 24.1 },
  ],
};

describe('buildTrendSeries', () => {
  it('plots a circumference oldest first, whatever order the sessions came in', () => {
    const series = buildTrendSeries(
      SOURCES,
      { kind: 'circumference', pointId: WAIST.id },
      undefined,
      NOW,
    );

    expect(series?.label).toBe('Waist');
    expect(series?.unit).toBe('cm');
    expect(series?.points?.map((point) => point.value)).toEqual([88.2, 87.1, 85.3]);
  });

  it('gives each metric its own unit, because they never share an axis', () => {
    // Centimetres, kilograms and percent on one plot would need two y-scales,
    // and the alignment between two scales is arbitrary.
    expect(buildTrendSeries(SOURCES, { kind: 'weight' }, undefined, NOW)?.unit).toBe('kg');
    expect(buildTrendSeries(SOURCES, { kind: 'bodyFat' }, undefined, NOW)?.unit).toBe('%');
  });

  it('returns body fat as a band, not a line', () => {
    const series = buildTrendSeries(SOURCES, { kind: 'bodyFat' }, undefined, NOW);

    // A single trace would imply precision the estimate does not have.
    expect(series?.band).toBeDefined();
    expect(series?.points).toBeUndefined();
    expect(series?.band?.[0]?.low).toBe(17.1);
  });

  it('honours the window', () => {
    // 91 days back from NOW reaches 21 June, leaving July and September.
    const series = buildTrendSeries(SOURCES, { kind: 'circumference', pointId: WAIST.id }, 91, NOW);

    expect(series?.points?.map((point) => point.value)).toEqual([87.1, 85.3]);
  });

  it('returns nothing for a metric with no data at all', () => {
    // An empty chart looks like a loading state or a bug, and it is neither.
    expect(
      buildTrendSeries(SOURCES, { kind: 'circumference', pointId: THIGH.id }, undefined, NOW),
    ).toBeUndefined();
    expect(
      buildTrendSeries({ ...SOURCES, weightKg: [] }, { kind: 'weight' }, undefined, NOW),
    ).toBeUndefined();
  });

  it('returns nothing for a point that does not exist', () => {
    expect(
      buildTrendSeries(
        SOURCES,
        { kind: 'circumference', pointId: 'point-nonsense' },
        undefined,
        NOW,
      ),
    ).toBeUndefined();
  });

  it('skips sessions that did not measure the point', () => {
    const withGap: TrendSources = {
      ...SOURCES,
      sessions: [...SOURCES.sessions, session('october', '2026-09-15T07:00:00.000Z')],
    };

    const series = buildTrendSeries(
      withGap,
      { kind: 'circumference', pointId: WAIST.id },
      undefined,
      NOW,
    );
    expect(trendLength(series!)).toBe(3);
  });
});

describe('trendExtent', () => {
  it('does not anchor to zero', () => {
    const series = buildTrendSeries(
      SOURCES,
      { kind: 'circumference', pointId: WAIST.id },
      undefined,
      NOW,
    )!;
    const extent = trendExtent(series);

    // Zero is not a meaningful baseline for a circumference, and anchoring to
    // it would flatten every real change into invisibility.
    expect(extent.min).toBeGreaterThan(80);
    expect(extent.max).toBeLessThan(95);
  });

  it('leaves headroom either side of the data', () => {
    const series = buildTrendSeries(
      SOURCES,
      { kind: 'circumference', pointId: WAIST.id },
      undefined,
      NOW,
    )!;
    const extent = trendExtent(series);

    expect(extent.min).toBeLessThan(85.3);
    expect(extent.max).toBeGreaterThan(88.2);
  });

  it('gives a flat series a nominal band instead of dividing by zero', () => {
    const flat = buildTrendSeries(
      {
        ...SOURCES,
        weightKg: [
          { capturedAt: '2026-06-14T07:30:00.000Z', value: 72 },
          { capturedAt: '2026-09-06T07:45:00.000Z', value: 72 },
        ],
      },
      { kind: 'weight' },
      undefined,
      NOW,
    )!;

    const extent = trendExtent(flat);
    expect(extent.max).toBeGreaterThan(extent.min);
    // A value that has not moved should draw as a line through the middle.
    expect((extent.min + extent.max) / 2).toBeCloseTo(72, 6);
  });

  it('spans both edges of a band', () => {
    const series = buildTrendSeries(SOURCES, { kind: 'bodyFat' }, undefined, NOW)!;
    const extent = trendExtent(series);

    expect(extent.min).toBeLessThan(15.3);
    expect(extent.max).toBeGreaterThan(24.1);
  });
});
