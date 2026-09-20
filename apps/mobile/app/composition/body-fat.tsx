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
 * The formula's inputs are gathered here too, as a checklist that lists what is
 * already satisfied alongside what is missing. That is the clearest answer to
 * "why is it asking me for my height?" — the athlete can see exactly what the
 * calculation rests on before they read its result.
 *
 * Data is stubbed: this is the UI half, built against the contract in the PRD.
 * Nothing here calls the API or the vision service yet.
 */

import React, { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

import {
  formatCanonicalLength,
  formatCanonicalMass,
  fromCanonicalLength,
  fromCanonicalMass,
  estimateBodyFatNavy,
  massUnitForLengthUnit,
  parseLength,
  parseMass,
  toCanonicalLength,
  toCanonicalMass,
  type LengthUnit,
  type MassUnit,
} from '@running/core';

import {
  CONFIDENCE_LABELS,
  METHOD_DESCRIPTIONS,
  METHOD_LABELS,
  STUB_ESTIMATES,
  STUB_SESSION_HAS_PHOTOS,
  aiAvailabilityMessage,
  estimateFor,
  formatRange,
  rangeWidth,
  type BodyFatEstimate,
  type BodyFatMethod,
} from '../../src/lib/body-fat';
import {
  HEIGHT_BOUNDS_CM,
  WEIGHT_BOUNDS_KG,
  canRunFormula,
  formulaRequirements,
  isPlausibleHeightCm,
  isPlausibleWeightKg,
  outstanding,
  type FormulaVariant,
} from '../../src/lib/body-fat-inputs';
import { findPoint } from '../../src/lib/body-composition';
import { useCompositionSessions } from '../../src/lib/composition-session-store';
import { useMeasurementUnit } from '../../src/lib/measurement-units';
import { UNIT_OPTIONS } from '../../src/lib/measurement-units';
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
import {
  BodyFatRange,
  FormulaSteps,
  NonMedicalNotice,
  QuantityField,
  RequirementList,
  ServiceStatusNotice,
  VariantPicker,
} from '../../src/components/composition';

const METHODS: readonly BodyFatMethod[] = ['formula', 'ai'];

const MASS_OPTIONS: readonly { value: string; label: string; description: string }[] = [
  { value: 'kg', label: 'kg', description: 'Kilograms' },
  { value: 'lb', label: 'lb', description: 'Pounds' },
];

export default function BodyFatScreen(): React.ReactElement {
  const { defaultUnit } = useMeasurementUnit();
  const { all: sessions } = useCompositionSessions();

  const [method, setMethod] = useState<BodyFatMethod>('formula');
  const [variant, setVariant] = useState<FormulaVariant>();

  // Height shares the tape unit; weight starts from whatever that implies and
  // is then the athlete's own to change.
  const [heightUnit, setHeightUnit] = useState<LengthUnit>(defaultUnit);
  const [massUnit, setMassUnit] = useState<MassUnit>(massUnitForLengthUnit(defaultUnit));
  const [heightText, setHeightText] = useState('');
  const [weightText, setWeightText] = useState('');

  const estimates = STUB_ESTIMATES;
  const selected = estimateFor(estimates, method);

  const heightTyped = parseLength(heightText);
  const heightCm =
    heightTyped === undefined ? undefined : toCanonicalLength(heightTyped, heightUnit);
  const weightTyped = parseMass(weightText);
  const weightKg = weightTyped === undefined ? undefined : toCanonicalMass(weightTyped, massUnit);

  /** Circumferences the most recent session recorded, keyed by point code. */
  const measuredCm = new Map<string, number>();
  for (const measurement of sessions[0]?.measurements ?? []) {
    const code = findPoint(measurement.pointId)?.code;
    if (code) measuredCm.set(code, measurement.valueCm);
  }
  const measuredCodes = [...measuredCm.keys()];

  const requirements = formulaRequirements({ variant, heightCm, weightKg }, measuredCodes);
  const ready = canRunFormula(requirements);
  const missing = outstanding(requirements);

  /**
   * The live calculation, once every input is in place.
   *
   * Computed from this session's own circumferences rather than from the stub,
   * so the steps on screen describe the athlete's actual measurements. The
   * photo method still has no implementation and keeps its fixture.
   */
  const computed =
    ready && variant && heightCm !== undefined
      ? estimateBodyFatNavy({
          variant,
          waistCm: measuredCm.get('waist') ?? 0,
          neckCm: measuredCm.get('neck') ?? 0,
          heightCm,
          ...(measuredCm.has('hips') ? { hipsCm: measuredCm.get('hips')! } : {}),
        })
      : undefined;

  const formulaEstimate: BodyFatEstimate | undefined =
    computed?.ok === true
      ? {
          id: 'computed-formula',
          sessionId: sessions[0]?.id ?? 'session',
          method: 'formula',
          valueLow: computed.valueLow,
          valueHigh: computed.valueHigh,
          // A formula fed complete measurements still only earns moderate:
          // nothing available here measures body fat.
          confidence: 'moderate',
          basis: `US Navy equation from this session's circumferences and a height of ${formatCanonicalLength(heightCm ?? 0, heightUnit)}.`,
          createdAt: new Date().toISOString(),
        }
      : undefined;

  /**
   * Whether the photo method can run, and what to offer if not.
   *
   * A session with no photos is a different problem from a service that is
   * down, and the two get different answers.
   */
  const photoAvailability = aiAvailabilityMessage(
    estimateFor(estimates, 'ai')?.serviceStatus,
    STUB_SESSION_HAS_PHOTOS,
  );

  /**
   * The estimate to display for the chosen method.
   *
   * For the formula, a live calculation beats the fixture. For photos, nothing
   * is shown unless the service could actually have produced it — a result left
   * on screen while the service is down reads as current, and an athlete has no
   * way to tell it apart from one taken a minute ago.
   */
  const shown =
    method === 'formula'
      ? (formulaEstimate ?? estimateFor(estimates, 'formula'))
      : photoAvailability.availability === 'ready'
        ? selected
        : undefined;

  const heightError =
    heightText !== '' && (heightCm === undefined || !isPlausibleHeightCm(heightCm))
      ? `Enter a height between ${formatCanonicalLength(HEIGHT_BOUNDS_CM.min, heightUnit)} and ${formatCanonicalLength(HEIGHT_BOUNDS_CM.max, heightUnit)}.`
      : undefined;

  const weightError =
    weightText !== '' && (weightKg === undefined || !isPlausibleWeightKg(weightKg))
      ? `Enter a weight between ${formatCanonicalMass(WEIGHT_BOUNDS_KG.min, massUnit)} and ${formatCanonicalMass(WEIGHT_BOUNDS_KG.max, massUnit)}.`
      : undefined;

  return (
    <Screen>
      <Stack gap={spacing.xl}>
        {method === 'ai' ? (
          <View>
            <SectionHeader title="Photo service" />
            <ServiceStatusNotice
              message={photoAvailability}
              onSwitchToFormula={() => setMethod('formula')}
              onTakePhotos={() => router.push('/composition/measurements')}
            />
          </View>
        ) : null}

        <View>
          <SectionHeader title="Latest estimate" />
          {shown ? (
            <BodyFatRange estimate={shown} />
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
          <SectionHeader title="Formula inputs" />
          <Card>
            <Stack gap={spacing.xl}>
              <VariantPicker value={variant} onChange={setVariant} />

              <Divider />

              <QuantityField
                label="Height"
                value={heightText}
                unit={heightUnit}
                onChangeText={setHeightText}
                onChangeUnit={(next) => {
                  // Convert what is already typed rather than dropping it: the
                  // athlete changed how it is read, not what they measured.
                  const asUnit = next as LengthUnit;
                  if (heightCm !== undefined) {
                    setHeightText(fromCanonicalLength(heightCm, asUnit).toFixed(1));
                  }
                  setHeightUnit(asUnit);
                }}
                unitOptions={UNIT_OPTIONS}
                hint="Used directly by the equation."
                {...(heightError ? { error: heightError } : {})}
              />

              <QuantityField
                label="Weight"
                value={weightText}
                unit={massUnit}
                onChangeText={setWeightText}
                onChangeUnit={(next) => {
                  const asUnit = next as MassUnit;
                  if (weightKg !== undefined) {
                    setWeightText(fromCanonicalMass(weightKg, asUnit).toFixed(1));
                  }
                  setMassUnit(asUnit);
                }}
                unitOptions={MASS_OPTIONS}
                hint="Not used by this equation, but shown alongside the result."
                {...(weightError ? { error: weightError } : {})}
              />
            </Stack>
          </Card>
        </View>

        <View>
          <SectionHeader title="What the formula needs" />
          <Card>
            <Stack gap={spacing.lg}>
              <Type variant="body" tone={ready ? 'positive' : 'secondary'}>
                {ready
                  ? 'Everything the equation reads is in place.'
                  : `Still needed: ${missing.map((requirement) => requirement.label.toLowerCase()).join(', ')}.`}
              </Type>
              <Divider />
              <RequirementList requirements={requirements} />
            </Stack>
          </Card>
        </View>

        {computed ? (
          <View>
            <SectionHeader title="The calculation" />
            <FormulaSteps estimate={computed} />
          </View>
        ) : null}

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

        <NonMedicalNotice />
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
