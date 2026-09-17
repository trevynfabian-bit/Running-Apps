/**
 * Measurement preferences held on the device.
 *
 * Only the unit, and only as a default for the next session. The readings
 * themselves are always stored in centimetres, so this decides how numbers are
 * shown and typed and nothing about what is recorded -- switching it can never
 * change a value that already exists.
 *
 * Device-local on purpose: which unit someone thinks in belongs to the tape
 * measure in their drawer, not to their account.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { MeasurementUnit } from '@running/core';

const UNIT_KEY = 'composition:measurement-unit';

/**
 * Centimetres unless the athlete has said otherwise.
 *
 * Falls back rather than throwing: an unreadable preference is not a reason to
 * keep someone out of a measurement form.
 */
export async function loadMeasurementUnit(): Promise<MeasurementUnit> {
  try {
    const stored = await AsyncStorage.getItem(UNIT_KEY);
    return stored === 'in' ? 'in' : 'cm';
  } catch {
    return 'cm';
  }
}

export async function saveMeasurementUnit(unit: MeasurementUnit): Promise<void> {
  try {
    await AsyncStorage.setItem(UNIT_KEY, unit);
  } catch {
    // A full disk must not stop the athlete switching units for this session.
  }
}
