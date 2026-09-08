/**
 * Body composition summary.
 *
 * The module's front door. It answers one question — how does my body look
 * and measure right now? — with the latest session in a single card: the
 * body-fat estimate as a labelled range, a handful of tape measurements, and
 * the four-sided portrait. With no sessions yet it explains what a session is
 * instead of showing an empty chart. Three quick actions lead to the things
 * an athlete does next, and the history lists every session newest first.
 *
 * Every number here is a measurement the athlete took or an estimate derived
 * from one. Estimates are shown as ranges with their method and confidence and
 * are never presented as a medical figure.
 */

import React from 'react';
import { RefreshControl } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import {
  bodyComposition,
  stubScenarioFromParam,
  type BodyCompositionSummary,
} from '../../src/lib/body-composition';
import { useQuery } from '../../src/lib/session';
import { spacing } from '../../src/design/tokens';
import { useTheme } from '../../src/design/theme';
import { ErrorState, LoadingState, Screen, Stack, Type } from '../../src/components/primitives';
import {
  LatestStatusCard,
  LatestStatusEmpty,
  QuickActions,
  SessionHistoryList,
  type QuickAction,
} from '../../src/components/body-composition';

const openNewSession = (): void => router.push('/body-composition/new-session');
const openMeasurements = (): void => router.push('/body-composition/measure');
const openComparison = (): void => router.push('/body-composition/compare');

const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    key: 'session',
    label: 'New session',
    hint: 'Four photos, then your measurements',
    glyph: '▣',
    onPress: openNewSession,
  },
  {
    key: 'measure',
    label: 'Measurements',
    hint: 'Log tape values in cm or inches',
    glyph: '≡',
    onPress: openMeasurements,
  },
  {
    key: 'compare',
    label: 'Compare',
    hint: 'Two sessions side by side',
    glyph: '⇄',
    onPress: openComparison,
  },
];

export default function BodyCompositionScreen(): React.ReactElement {
  const theme = useTheme();
  // Stub-only: `?scenario=empty` previews the first-run state while the
  // module has no API behind it. The real endpoint ignores it.
  const params = useLocalSearchParams<{ scenario?: string }>();
  const scenario = stubScenarioFromParam(params.scenario);

  const summary = useQuery<BodyCompositionSummary>(
    () => bodyComposition.summary({ scenario }),
    [scenario],
  );

  if (summary.loading && !summary.data) {
    return <LoadingState label="Loading your body composition" />;
  }

  if (!summary.data) {
    return (
      <Screen>
        <ErrorState
          message={summary.error ?? 'We could not load your body composition.'}
          onRetry={() => void summary.refresh()}
        />
      </Screen>
    );
  }

  const data = summary.data;
  const latest = data.latest;

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={summary.loading}
          onRefresh={() => void summary.refresh()}
          tintColor={theme.color.textTertiary}
        />
      }
    >
      <Stack gap={spacing.xl}>
        <Stack gap={spacing.xs}>
          <Type variant="title">Body composition</Type>
          <Type variant="body" tone="secondary">
            Four photos, tape measurements and a labelled body-fat estimate, recorded session by
            session.
          </Type>
          {summary.stale ? (
            <Type variant="caption" tone="caution">
              Offline — showing your last synced data
            </Type>
          ) : null}
        </Stack>

        {latest ? (
          <LatestStatusCard session={latest} />
        ) : (
          <LatestStatusEmpty onStartSession={openNewSession} />
        )}

        <QuickActions actions={QUICK_ACTIONS} />

        <SessionHistoryList sessions={data.sessions} />
      </Stack>
    </Screen>
  );
}
