/**
 * Session state and a small data-fetching hook.
 *
 * Deliberately dependency-free rather than pulling in a query library: the app
 * has a handful of endpoints, all read-mostly, and the caching that matters
 * (offline fallback) already lives in the API client.
 */

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

import { api, clearCache, clearToken, loadToken, saveToken, type ApiResult } from './api';

interface SessionValue {
  status: 'loading' | 'signed_out' | 'signed_in';
  displayName?: string;
  hasCompletedOnboarding: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName: string) => Promise<void>;
  signOut: () => Promise<void>;
  markOnboarded: () => void;
}

const SessionContext = createContext<SessionValue | undefined>(undefined);

export function SessionProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [status, setStatus] = useState<SessionValue['status']>('loading');
  const [displayName, setDisplayName] = useState<string>();
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(false);

  useEffect(() => {
    void (async () => {
      const token = await loadToken();
      if (!token) {
        setStatus('signed_out');
        return;
      }
      try {
        const { data } = await api.me();
        setDisplayName(data.displayName);
        setHasCompletedOnboarding(data.hasCompletedOnboarding);
        setStatus('signed_in');
      } catch {
        // A stored token that no longer works means signed out, not an error
        // screen the athlete has to dismiss.
        await clearToken();
        setStatus('signed_out');
      }
    })();
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { data } = await api.signIn({ email, password });
    await saveToken(data.token);
    setDisplayName(data.user.displayName);
    setHasCompletedOnboarding(data.hasCompletedOnboarding);
    setStatus('signed_in');
  }, []);

  const signUp = useCallback(async (email: string, password: string, name: string) => {
    const { data } = await api.signUp({ email, password, displayName: name });
    await saveToken(data.token);
    setDisplayName(data.user.displayName);
    setHasCompletedOnboarding(false);
    setStatus('signed_in');
  }, []);

  const signOut = useCallback(async () => {
    // Clearing the cache matters: health data must not outlive the session on
    // a shared device.
    await Promise.all([clearToken(), clearCache()]);
    setDisplayName(undefined);
    setHasCompletedOnboarding(false);
    setStatus('signed_out');
  }, []);

  const markOnboarded = useCallback(() => setHasCompletedOnboarding(true), []);

  return (
    <SessionContext.Provider
      value={{ status, displayName, hasCompletedOnboarding, signIn, signUp, signOut, markOnboarded }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside a SessionProvider');
  return value;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export interface QueryState<T> {
  data?: T;
  error?: string;
  loading: boolean;
  /** True when the displayed data came from cache after a network failure. */
  stale: boolean;
  refresh: () => Promise<void>;
}

export function useQuery<T>(
  fetcher: () => Promise<ApiResult<T>>,
  deps: readonly unknown[] = [],
): QueryState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetcher();
      setData(result.data);
      setStale(result.fromCache);
      setError(undefined);
    } catch (err) {
      // API errors already carry athlete-facing wording.
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
    // Deps are supplied by the caller and intentionally dynamic.
  }, deps);

  useEffect(() => {
    void run();
  }, [run]);

  return { data, error, loading, stale, refresh: run };
}
