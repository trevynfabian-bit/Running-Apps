/**
 * The behaviour this module exists for: whichever unit the athlete last chose
 * is the one the next entry opens in, including after the app is restarted.
 *
 * These cover the storage layer rather than the React context — the context is
 * a thin read of these functions, and testing it would mean standing up a
 * React Native renderer for no extra coverage.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  },
}));

const { FALLBACK_UNIT, clearDefaultUnit, loadDefaultUnit, saveDefaultUnit } =
  await import('./measurement-units');

const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;

describe('default measurement unit', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('starts in centimetres for an athlete who has never chosen', async () => {
    expect(await loadDefaultUnit()).toBe('cm');
    expect(FALLBACK_UNIT).toBe('cm');
  });

  it('gives back the unit that was saved, so the next entry opens in it', async () => {
    await saveDefaultUnit('in');
    expect(await loadDefaultUnit()).toBe('in');

    // Switching back is just as sticky.
    await saveDefaultUnit('cm');
    expect(await loadDefaultUnit()).toBe('cm');
  });

  it('survives a restart — the value is read from storage, not from memory', async () => {
    await saveDefaultUnit('in');
    // A fresh import is the closest stand-in for a cold start: nothing is
    // cached in module scope, so the answer has to come from storage.
    vi.resetModules();
    const reloaded = await import('./measurement-units');
    expect(await reloaded.loadDefaultUnit()).toBe('in');
  });

  it('falls back rather than returning a unit the app cannot use', async () => {
    store.set('running-os.preferences.measurement-unit', 'furlongs');
    expect(await loadDefaultUnit()).toBe('cm');
  });

  it('falls back when storage itself fails', async () => {
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('storage unavailable'));
    expect(await loadDefaultUnit()).toBe('cm');
  });

  it('never lets a failed write break the entry being recorded', async () => {
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
    await expect(saveDefaultUnit('in')).resolves.toBeUndefined();
  });

  it('clears the preference on sign-out, returning the next athlete to cm', async () => {
    await saveDefaultUnit('in');
    await clearDefaultUnit();
    expect(await loadDefaultUnit()).toBe('cm');
  });
});
