/**
 * The athlete's default tape-measure unit.
 *
 * One preference, read by every new circumference entry. The point is that an
 * athlete picks centimetres or inches once and never touches the toggle again:
 * whatever they chose last is what the next entry — and the entry after an app
 * restart — opens in.
 *
 * Two rules keep that from rewriting history:
 *
 *   1. The default applies to entries *not yet recorded*. A value already saved
 *      keeps the unit it was measured in, because that is what the athlete read
 *      off the tape. Display converts; the record does not change.
 *   2. Storage is per-device and non-sensitive — it is a display preference, not
 *      a body measurement — but it is still cleared on sign-out so a shared
 *      device does not hand the next person the previous one's setup.
 *
 * Kept in context rather than a module-level variable so a change re-renders
 * every entry form currently mounted, and so the first paint can wait for the
 * stored value instead of flashing `cm` at someone who chose inches.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { CANONICAL_LENGTH_UNIT, type LengthUnit } from '@running/core';

const UNIT_KEY = 'running-os.preferences.measurement-unit';

/**
 * Centimetres until the athlete says otherwise — it matches the canonical
 * storage unit, so the common case needs no conversion at all.
 */
export const FALLBACK_UNIT: LengthUnit = CANONICAL_LENGTH_UNIT;

export const UNIT_OPTIONS: readonly { value: LengthUnit; label: string; description: string }[] = [
  { value: 'cm', label: 'cm', description: 'Sentimeter' },
  { value: 'in', label: 'in', description: 'Inci' },
];

function isLengthUnit(value: unknown): value is LengthUnit {
  return value === 'cm' || value === 'in';
}

export async function loadDefaultUnit(): Promise<LengthUnit> {
  try {
    const stored = await AsyncStorage.getItem(UNIT_KEY);
    // A value written by an older build, or corrupted storage, falls back
    // rather than propagating an unusable unit into the entry form.
    return isLengthUnit(stored) ? stored : FALLBACK_UNIT;
  } catch {
    return FALLBACK_UNIT;
  }
}

export async function saveDefaultUnit(unit: LengthUnit): Promise<void> {
  try {
    await AsyncStorage.setItem(UNIT_KEY, unit);
  } catch {
    // Losing the preference is a minor annoyance; failing the measurement the
    // athlete is in the middle of recording is not acceptable.
  }
}

/** Drop the stored preference. Called on sign-out alongside the data caches. */
export async function clearDefaultUnit(): Promise<void> {
  try {
    await AsyncStorage.removeItem(UNIT_KEY);
  } catch {
    // Nothing to recover from — the key either went away or was never there.
  }
}

interface MeasurementUnitValue {
  /** The unit every new entry starts in. */
  defaultUnit: LengthUnit;
  /** False until the stored preference has been read. */
  ready: boolean;
  /** Change the default. Takes effect on the next entry, not on saved ones. */
  setDefaultUnit: (unit: LengthUnit) => void;
}

const MeasurementUnitContext = createContext<MeasurementUnitValue | undefined>(undefined);

export function MeasurementUnitProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [defaultUnit, setUnit] = useState<LengthUnit>(FALLBACK_UNIT);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await loadDefaultUnit();
      if (cancelled) return;
      setUnit(stored);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setDefaultUnit = useCallback((unit: LengthUnit) => {
    // Update state first: the toggle must feel instant, and persistence
    // failing is not a reason to reject the choice for this session.
    setUnit(unit);
    void saveDefaultUnit(unit);
  }, []);

  const value = useMemo(
    () => ({ defaultUnit, ready, setDefaultUnit }),
    [defaultUnit, ready, setDefaultUnit],
  );

  return (
    <MeasurementUnitContext.Provider value={value}>{children}</MeasurementUnitContext.Provider>
  );
}

export function useMeasurementUnit(): MeasurementUnitValue {
  const value = useContext(MeasurementUnitContext);
  if (!value) {
    throw new Error('useMeasurementUnit must be used inside a MeasurementUnitProvider');
  }
  return value;
}
