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
