/**
 * Things that must be forgotten when an athlete signs out.
 *
 * The problem this solves is a tree-shape one. `SessionProvider` owns sign-out,
 * but the providers holding body data sit *below* it, so it cannot reach into
 * them — and the obvious fix, hoisting them above, only works until the next
 * provider needs to clear something and the order is wrong again.
 *
 * Instead each holder registers what to forget. Sign-out runs every
 * registration, so a provider added later joins by importing this rather than
 * by rearranging the tree, and nothing can be left behind because someone
 * forgot to add a line to `signOut`.
 *
 * This matters more than the plumbing suggests: what is being forgotten is
 * photographs of someone's body and the measurements taken from them, on a
 * phone that may be handed to the next person.
 */

type Cleanup = () => void | Promise<void>;

const registered = new Set<Cleanup>();

/**
 * Register something to forget on sign-out.
 *
 * Returns the function that unregisters it, so a provider can hand it straight
 * to `useEffect` as a teardown.
 */
export function registerSignOutCleanup(cleanup: Cleanup): () => void {
  registered.add(cleanup);
  return () => {
    registered.delete(cleanup);
  };
}

/**
 * Run every registered cleanup.
 *
 * One failing cleanup must not stop the others: a sign-out that gave up
 * halfway would leave exactly the data it was supposed to remove, and the
 * athlete would have no way to know. Every one is attempted and the failures
 * are reported together.
 */
export async function runSignOutCleanups(): Promise<{ ran: number; failed: number }> {
  const results = await Promise.allSettled(
    // The callback is async so that a cleanup throwing *synchronously* becomes
    // a rejected promise rather than escaping the map and taking the whole
    // sign-out with it — which is the very failure this function exists to
    // contain.
    [...registered].map(async (cleanup) => cleanup()),
  );

  return {
    ran: results.length,
    failed: results.filter((result) => result.status === 'rejected').length,
  };
}

/** Test hook: drop every registration. */
export function resetSignOutCleanupsForTesting(): void {
  registered.clear();
}

/** How many cleanups are currently registered. Exposed for tests. */
export function registeredCleanupCount(): number {
  return registered.size;
}

/**
 * Everything sign-out does, in the order it has to happen.
 *
 * Lives here rather than in the session provider for two reasons: it is the
 * part of sign-out that has a wrong answer, and keeping it free of React
 * Native imports is what lets that answer be tested.
 *
 * The steps are passed in rather than imported. Not for flexibility — there is
 * exactly one caller — but because importing them would pull the whole native
 * storage layer in behind them and put this back out of reach of a test.
 */
export async function signOutSequence(steps: {
  /** Tell the server to stop honouring this account's tokens. */
  revoke: () => Promise<unknown>;
  /** Everything to forget locally, in any order. */
  forget: readonly (() => Promise<unknown>)[];
}): Promise<{ revoked: boolean; forgotten: number; failed: number }> {
  // Revoke first, while the token is still there to authenticate with.
  // Forgetting it locally does not stop it working: it is a bearer token good
  // for thirty days, so anyone holding a copy could go on reading this
  // athlete's body photographs long after they signed out.
  //
  // Failure is swallowed on purpose. Signing out on a plane must still sign
  // the athlete out of the phone in their hand; a sign-out the app refuses to
  // perform is worse than one the server has not heard about yet, and the
  // token does expire on its own in the end.
  let revoked = true;
  try {
    await steps.revoke();
  } catch {
    revoked = false;
  }

  // Settled, not `all`, for the same reason `runSignOutCleanups` is: one step
  // failing must not abandon the rest, or sign-out leaves behind exactly the
  // data it exists to remove.
  const results = await Promise.allSettled(steps.forget.map(async (step) => step()));

  return {
    revoked,
    forgotten: results.length,
    failed: results.filter((result) => result.status === 'rejected').length,
  };
}
