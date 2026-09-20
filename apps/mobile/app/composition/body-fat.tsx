/**
 * Body fat estimate.
 *
 * The screen leads with a band and a caveat, in that order, because the failure
 * mode here is not a wrong number — it is a number that looks more certain than
 * it is. An athlete who reads "18.4%" writes it in a log and compares it to
 * last week; an athlete who reads "17.4–20.2%" understands that a week of
 * change is noise and a season of change is not.
 *
 * Two methods are offered side by side rather than one blended answer. They
 * disagree, sometimes by several points, and averaging them away would hide the
 * only honest signal available: when two different estimates land in the same
 * place, that is worth something, and when they do not, the athlete should see
 * it rather than be handed a confident midpoint.
 *
 * Data is stubbed: this is the UI half, built against the contract in the PRD.
 * Nothing here calls the API or the vision service yet.
 */

import React, { useState } from 'react';
import { View } from 'react-native';

import {
  CONFIDENCE_LABELS,
  METHOD_DESCRIPTIONS,
  METHOD_LABELS,
  NON_MEDICAL_NOTE,
  STUB_ESTIMATES,
  estimateFor,
  formatRange,
  rangeWidth,
  type BodyFatEstimate,
  type BodyFatMethod,
} from '../../src/lib/body-fat';
import { spacing } from '../../src/design/tokens';
import {
  Card,
  Chip,
  Divider,
  EmptyState,
  Screen,
  SectionHeader,
  Stack,
  Type,
} from '../../src/components/primitives';
import { BodyFatRange } from '../../src/components/composition';

const METHODS: readonly BodyFatMethod[] = ['formula', 'ai'];

export default function BodyFatScreen(): React.ReactElement {
  const [method, setMethod] = useState<BodyFatMethod>('formula');

  const estimates = STUB_ESTIMATES;
  const selected = estimateFor(estimates, method);

  return (
    <Screen>
      <Stack gap={spacing.xl}>
        <View>
          <SectionHeader title="Latest estimate" />
          {selected ? (
            <BodyFatRange estimate={selected} />
          ) : (
            <EmptyState
              title={`No ${METHOD_LABELS[method].toLowerCase()} estimate yet`}
              body="Record a session with this method to see a result here."
            />
          )}
        </View>

        <View>
          <SectionHeader title="Method" />
          <Card>
            <Stack gap={spacing.lg}>
              <Stack direction="row" gap={spacing.sm} style={{ flexWrap: 'wrap' }}>
                {METHODS.map((option) => (
                  <Chip
                    key={option}
                    label={METHOD_LABELS[option]}
                    selected={option === method}
                    tone={option === method ? 'accent' : 'neutral'}
                    onPress={() => setMethod(option)}
                  />
                ))}
              </Stack>
              <Type variant="body" tone="secondary">
                {METHOD_DESCRIPTIONS[method]}
              </Type>
            </Stack>
          </Card>
        </View>

        <View>
          <SectionHeader title="Both methods" />
          <Card>
            <Stack gap={spacing.md}>
              {/* Side by side rather than blended: where they agree is the
                  only honest signal available, and a midpoint would hide it. */}
              {METHODS.map((option, index) => (
                <React.Fragment key={option}>
                  {index > 0 ? <Divider /> : null}
                  <ComparisonRow
                    label={METHOD_LABELS[option]}
                    estimate={estimateFor(estimates, option)}
                  />
                </React.Fragment>
              ))}
            </Stack>
          </Card>
        </View>

        <Card>
          <Stack gap={spacing.sm}>
            <Type variant="bodyStrong" tone="caution">
              What this number is
            </Type>
            <Type variant="body" tone="secondary">
              {NON_MEDICAL_NOTE}
            </Type>
          </Stack>
        </Card>
      </Stack>
    </Screen>
  );
}

function ComparisonRow({
  label,
  estimate,
}: {
  label: string;
  estimate?: BodyFatEstimate;
}): React.ReactElement {
  return (
    <View
      accessible
      accessibilityLabel={
        estimate
          ? `${label}, ${formatRange(estimate)}, ${CONFIDENCE_LABELS[estimate.confidence]}`
          : `${label}, no estimate yet`
      }
    >
      <Stack direction="row" justify="space-between" align="center" gap={spacing.md}>
        <Stack gap={2} style={{ flexShrink: 1 }}>
          <Type variant="bodyStrong" tone={estimate ? 'default' : 'secondary'}>
            {label}
          </Type>
          <Type variant="caption" tone="tertiary">
            {estimate
              ? `${CONFIDENCE_LABELS[estimate.confidence]} · ${rangeWidth(estimate).toFixed(1)} point spread`
              : 'Not available'}
          </Type>
        </Stack>
        <Type variant="metricSmall" tone={estimate ? 'default' : 'tertiary'}>
          {estimate ? formatRange(estimate) : '—'}
        </Type>
      </Stack>
    </View>
  );
}
