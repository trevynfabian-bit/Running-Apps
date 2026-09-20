/**
 * What is being forgotten here is photographs of someone's body on a phone
 * that may be handed to the next person, so the failure modes matter.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerSignOutCleanup,
  registeredCleanupCount,
  resetSignOutCleanupsForTesting,
  runSignOutCleanups,
} from './sign-out-cleanup';

beforeEach(() => resetSignOutCleanupsForTesting());

describe('registerSignOutCleanup', () => {
  it('runs everything registered', async () => {
    const first = vi.fn();
    const second = vi.fn();

    registerSignOutCleanup(first);
    registerSignOutCleanup(second);

    const result = await runSignOutCleanups();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(result).toEqual({ ran: 2, failed: 0 });
  });

  it('awaits an async cleanup', async () => {
    let finished = false;
    registerSignOutCleanup(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished = true;
    });

    await runSignOutCleanups();
    expect(finished).toBe(true);
  });

  it('runs the rest when one fails', async () => {
    const after = vi.fn();

    registerSignOutCleanup(() => {
      throw new Error('storage unavailable');
    });
    registerSignOutCleanup(after);

    const result = await runSignOutCleanups();

    // A sign-out that gave up halfway would leave exactly the data it was
    // supposed to remove, with no way for the athlete to know.
    expect(after).toHaveBeenCalledOnce();
    expect(result).toEqual({ ran: 2, failed: 1 });
  });

  it('reports a rejected promise as a failure, not a success', async () => {
    registerSignOutCleanup(async () => {
      throw new Error('nope');
    });

    expect(await runSignOutCleanups()).toEqual({ ran: 1, failed: 1 });
  });

  it('unregisters on teardown, so an unmounted provider is not called', async () => {
    const cleanup = vi.fn();
    const unregister = registerSignOutCleanup(cleanup);

    expect(registeredCleanupCount()).toBe(1);
    unregister();
    expect(registeredCleanupCount()).toBe(0);

    await runSignOutCleanups();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('is a no-op when nothing is registered', async () => {
    expect(await runSignOutCleanups()).toEqual({ ran: 0, failed: 0 });
  });
});
