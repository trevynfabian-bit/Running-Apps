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
  signOutSequence,
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

/**
 * Telling the server has to come before forgetting the token, because the
 * token is what authenticates the telling. Get it the wrong way round and
 * sign-out silently stops revoking anything — the app looks identical, and the
 * bearer token that reads body photographs keeps working for a month.
 */
/** Records the order steps ran in. */
function recorder(): { log: string[]; step: (name: string) => () => Promise<void> } {
  const log: string[] = [];
  return {
    log,
    step: (name: string) => async () => {
      log.push(name);
    },
  };
}

describe('signOutSequence', () => {
  it('revokes before it forgets', async () => {
    const { log, step } = recorder();

    await signOutSequence({
      revoke: step('revoke'),
      forget: [step('clear-token'), step('clear-cache')],
    });

    expect(log[0]).toBe('revoke');
    expect(log.slice(1).sort()).toEqual(['clear-cache', 'clear-token']);
  });

  it('still forgets everything when the server cannot be reached', async () => {
    const { log, step } = recorder();

    const result = await signOutSequence({
      revoke: () => Promise.reject(new Error('offline')),
      forget: [step('clear-token'), step('clear-cache'), step('clear-composition')],
    });

    // Signing out on a plane must still sign the athlete out of the phone.
    expect(result.revoked).toBe(false);
    expect(result.failed).toBe(0);
    expect(log.sort()).toEqual(['clear-cache', 'clear-composition', 'clear-token']);
  });

  it('survives a revoke that throws synchronously', async () => {
    const { log, step } = recorder();

    const result = await signOutSequence({
      revoke: () => {
        throw new Error('no token on disk');
      },
      forget: [step('clear-token')],
    });

    expect(result.revoked).toBe(false);
    expect(log).toEqual(['clear-token']);
  });

  it('runs the remaining steps when one of them fails', async () => {
    const { log, step } = recorder();

    const result = await signOutSequence({
      revoke: step('revoke'),
      forget: [
        step('clear-token'),
        () => Promise.reject(new Error('cache locked')),
        step('clear-composition'),
      ],
    });

    // A half-done sign-out leaves behind exactly the data it exists to remove.
    expect(result.failed).toBe(1);
    expect(result.forgotten).toBe(3);
    expect(log.sort()).toEqual(['clear-composition', 'clear-token', 'revoke']);
  });

  it('reports a clean sign-out', async () => {
    const { step } = recorder();

    const result = await signOutSequence({
      revoke: step('revoke'),
      forget: [step('clear-token')],
    });

    expect(result).toEqual({ revoked: true, forgotten: 1, failed: 0 });
  });
});
