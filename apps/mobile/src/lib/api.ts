/**
 * API client.
 *
 * Two behaviours matter more than the transport details:
 *
 * Offline-first reads. Every GET is cached, and a failed request falls back to
 * the last good response rather than showing an error. An athlete standing at
 * the trailhead with no signal should still see today's workout.
 *
 * Errors are already athlete-readable. The API returns a stable code plus a
 * sentence written for a person, so the client surfaces `error.message`
 * verbatim and never constructs its own wording from a status code.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

const TOKEN_KEY = 'running-os.auth-token';
const CACHE_PREFIX = 'running-os.cache.';

/**
 * Base URL resolution.
 *
 * EXPO_PUBLIC_ variables are embedded in the bundle and are NOT secret — only
 * values safe to ship publicly belong here. The API URL qualifies; nothing
 * else in this app does.
 */
function resolveBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');

  const fromConfig = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;
  if (fromConfig) return fromConfig.replace(/\/$/, '');

  // Android emulators reach the host machine on 10.0.2.2, not localhost.
  return Platform.OS === 'android' ? 'http://10.0.2.2:4000' : 'http://localhost:4000';
}

export const API_BASE_URL = resolveBaseUrl();

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    override readonly message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** Signals the caller is showing cached data because the network failed. */
export class OfflineError extends Error {
  constructor() {
    super('You appear to be offline. Showing the most recent data we have.');
    this.name = 'OfflineError';
  }
}

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

/**
 * The auth token is a credential, so it goes in the Keychain/Keystore via
 * SecureStore rather than AsyncStorage. SecureStore has no web implementation,
 * so web development falls back to AsyncStorage.
 */
export async function saveToken(token: string): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.setItem(TOKEN_KEY, token);
    return;
  }
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function loadToken(): Promise<string | undefined> {
  try {
    const value =
      Platform.OS === 'web'
        ? await AsyncStorage.getItem(TOKEN_KEY)
        : await SecureStore.getItemAsync(TOKEN_KEY);
    return value ?? undefined;
  } catch {
    return undefined;
  }
}

export async function clearToken(): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.removeItem(TOKEN_KEY);
    return;
  }
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  cachedAt: number;
}

async function readCache<T>(key: string): Promise<CacheEntry<T> | undefined> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_PREFIX + key);
    return raw ? (JSON.parse(raw) as CacheEntry<T>) : undefined;
  } catch {
    return undefined;
  }
}

async function writeCache<T>(key: string, data: T): Promise<void> {
  try {
    await AsyncStorage.setItem(
      CACHE_PREFIX + key,
      JSON.stringify({ data, cachedAt: Date.now() } satisfies CacheEntry<T>),
    );
  } catch {
    // A full disk must not break the request that just succeeded.
  }
}

/** Clear cached responses. Used on sign-out so no data survives the session. */
export async function clearCache(): Promise<void> {
  const keys = await AsyncStorage.getAllKeys();
  const ours = keys.filter((key) => key.startsWith(CACHE_PREFIX));
  if (ours.length > 0) await AsyncStorage.multiRemove(ours);
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Serve from cache when the request fails. GETs only. */
  cacheKey?: string;
  timeoutMs?: number;
}

export interface ApiResult<T> {
  data: T;
  /** True when this came from cache because the network was unavailable. */
  fromCache: boolean;
  cachedAt?: number;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
  const method = options.method ?? 'GET';
  const token = await loadToken();

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as
        | { error?: { code?: string; message?: string } }
        | undefined;

      throw new ApiRequestError(
        response.status,
        payload?.error?.code ?? 'unknown',
        // The API writes these for the athlete; pass them through untouched.
        payload?.error?.message ?? 'Something went wrong. Please try again.',
      );
    }

    const data = (await response.json()) as T;
    if (options.cacheKey) await writeCache(options.cacheKey, data);
    return { data, fromCache: false };
  } catch (error) {
    // An API error is a real answer from the server — never mask it with cache.
    if (error instanceof ApiRequestError) throw error;

    if (options.cacheKey) {
      const cached = await readCache<T>(options.cacheKey);
      if (cached) return { data: cached.data, fromCache: true, cachedAt: cached.cachedAt };
    }

    throw new OfflineError();
  }
}

// ---------------------------------------------------------------------------
// Typed endpoints
// ---------------------------------------------------------------------------

export const api = {
  signUp: (body: { email: string; password: string; displayName: string }) =>
    request<{ token: string; user: { id: string; displayName: string }; hasCompletedOnboarding: boolean }>(
      '/api/auth/signup',
      { method: 'POST', body },
    ),

  signIn: (body: { email: string; password: string }) =>
    request<{ token: string; user: { id: string; displayName: string }; hasCompletedOnboarding: boolean }>(
      '/api/auth/signin',
      { method: 'POST', body },
    ),

  me: () => request<AthleteProfileResponse>('/api/me', { cacheKey: 'me' }),

  updateMe: (body: Record<string, unknown>) =>
    request<{ ok: boolean }>('/api/me', { method: 'PATCH', body }),

  completeOnboarding: () =>
    request<{ ok: boolean }>('/api/me/complete-onboarding', { method: 'POST' }),

  dashboard: () => request<DashboardResponse>('/api/dashboard', { cacheKey: 'dashboard' }),

  checkIn: (body: {
    energy: number;
    soreness: number;
    stress: number;
    motivation: number;
    hasPain: boolean;
    painNote?: string;
  }) => request<CheckInResponse>('/api/check-in', { method: 'POST', body }),

  recovery: () => request<RecoveryResponse>('/api/recovery', { cacheKey: 'recovery' }),

  plan: () => request<PlanResponse>('/api/training-plan', { cacheKey: 'plan' }),

  generatePlan: (body: { template: string; raceGoalId?: string; totalWeeks?: number }) =>
    request<{ id: string; blocks: number; workouts: number }>('/api/training-plan/generate', {
      method: 'POST',
      body,
      timeoutMs: 60_000,
    }),

  workouts: (limit = 50) =>
    request<{ workouts: WorkoutSummary[] }>(`/api/workouts?limit=${limit}`, {
      cacheKey: 'workouts',
    }),

  workout: (id: string) => request<WorkoutDetail>(`/api/workouts/${id}`),

  logWorkout: (body: Record<string, unknown>) =>
    request<{ id: string }>('/api/workouts', { method: 'POST', body }),

  progress: (windowDays = 84) =>
    request<ProgressResponse>(`/api/progress?windowDays=${windowDays}`, { cacheKey: 'progress' }),

  raceGoals: () => request<{ goals: RaceGoal[] }>('/api/race-goals', { cacheKey: 'race-goals' }),

  createRaceGoal: (body: {
    name: string;
    date: string;
    distanceMeters: number;
    targetDurationSeconds?: number;
  }) => request<{ id: string }>('/api/race-goals', { method: 'POST', body }),

  createRaceResult: (body: {
    distanceMeters: number;
    durationSeconds: number;
    date: string;
    source?: string;
    name?: string;
  }) => request<{ id: string }>('/api/race-results', { method: 'POST', body }),

  weeklyReview: () => request<WeeklyReview>('/api/reviews/weekly', { cacheKey: 'weekly-review' }),

  connections: () =>
    request<{ connections: Connection[] }>('/api/connections', { cacheKey: 'connections' }),

  connect: (provider: string) =>
    request<{ authorizationUrl?: string; connected?: boolean; mockMode?: boolean; message?: string }>(
      `/api/connections/${provider}/connect`,
      { method: 'POST' },
    ),

  sync: (provider: string, full = false) =>
    request<SyncResult>(`/api/connections/${provider}/sync?full=${full}`, {
      method: 'POST',
      timeoutMs: 120_000,
    }),

  disconnect: (provider: string, deleteData: boolean) =>
    request<{ ok: boolean; recordsDeleted: number }>(
      `/api/connections/${provider}?deleteData=${deleteData}`,
      { method: 'DELETE' },
    ),

  ingestHealthKit: (body: { workouts: unknown[]; samples: unknown[] }) =>
    request<{ ingested: number; duplicatesMerged: number }>('/api/connections/healthkit/ingest', {
      method: 'POST',
      body,
      timeoutMs: 60_000,
    }),

  coachMessage: (message: string) =>
    request<CoachResponse>('/api/coach/message', {
      method: 'POST',
      body: { message },
      timeoutMs: 60_000,
    }),

  coachHistory: () =>
    request<{ messages: CoachHistoryMessage[] }>('/api/coach/history', { cacheKey: 'coach' }),
};

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface AthleteProfileResponse {
  id: string;
  displayName: string;
  dateOfBirth?: string;
  sex: string;
  background: Record<string, unknown>;
  availability: Record<string, unknown>;
  constraints: Record<string, unknown>;
  preferences: { units: string; primaryZoneMethodology: string; timezone: string };
  markers: {
    maxHeartRateBpm?: number;
    restingHeartRateBpm?: number;
    thresholdHeartRateBpm?: number;
  };
  hasCompletedOnboarding: boolean;
}

export interface PlannedWorkout {
  id: string;
  date: string;
  type: string;
  title: string;
  purpose: string;
  targetDistanceMeters?: number;
  targetDurationSeconds?: number;
  targetRpe?: number;
  status: string;
  structure?: WorkoutStructure;
  modifiedFrom?: { type: string; reason: string };
}

export interface WorkoutStructure {
  warmup?: WorkoutStep;
  main: (
    | { kind: 'step'; step: WorkoutStep }
    | { kind: 'repeat'; repeat: { id: string; repetitions: number; steps: WorkoutStep[] } }
  )[];
  cooldown?: WorkoutStep;
}

export interface WorkoutStep {
  id: string;
  label: string;
  durationSeconds?: number;
  distanceMeters?: number;
  isRecovery?: boolean;
  target: Record<string, unknown>;
}

export interface DashboardResponse {
  date: string;
  greeting: string;
  readiness: { score: number; band: 'green' | 'yellow' | 'red'; summary: string; dataCompleteness: number };
  todayWorkout?: PlannedWorkout;
  decision?: {
    id: string;
    decision: string;
    confidence: number;
    headline: string;
    explanation: string;
    reasons: { key: string; message: string; severity: string; detail?: string }[];
  };
  trainingState: {
    state: string;
    summary: string;
    confidence: number;
    recommendProfessionalReview: boolean;
  };
  weeklyProgress: {
    completedDistanceMeters: number;
    targetDistanceMeters: number;
    completedSessions: number;
    plannedSessions: number;
  };
  currentBlock?: { name: string; goal: string; weekInBlock: number; weeksInBlock: number };
  raceGoal?: {
    id: string;
    name: string;
    date: string;
    distanceMeters: number;
    targetDurationSeconds?: number;
    currentEstimateSeconds?: number;
    gapSeconds?: number;
    weeksRemaining: number;
    confidence: string;
  };
  zones?: {
    methodology: string;
    kind: string;
    note?: string;
    zones: { number: number; name: string; purpose: string; lowerBound: number; upperBound: number }[];
  };
  needsCheckIn: boolean;
}

export interface CheckInResponse {
  ok: boolean;
  readiness: { score: number; band: 'green' | 'yellow' | 'red'; summary: string };
  decision?: { decision: string; headline: string; explanation: string };
}

export interface RecoveryResponse {
  today: {
    date: string;
    score: number;
    band: 'green' | 'yellow' | 'red';
    components: { key: string; label: string; score: number; weight: number; detail: string }[];
    missingSignals: string[];
    dataCompleteness: number;
    summary: string;
  };
  history: { date: string; score: number; band: string }[];
  sleep: { date: string; hours: number; performancePercent?: number }[];
}

export interface PlanResponse {
  plan?: {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    blocks: {
      id: string;
      type: string;
      name: string;
      goal: string;
      startDate: string;
      endDate: string;
      durationWeeks: number;
    }[];
    generationBasis: { notes: string[] };
  };
  weeks: {
    weekStart: string;
    weekKey: string;
    blockName: string;
    blockType: string;
    weekInBlock: number;
    weeksInBlock: number;
    targetDistanceMeters: number;
    completedDistanceMeters: number;
    workouts: PlannedWorkout[];
  }[];
}

export interface WorkoutSummary {
  id: string;
  type: string;
  sport: string;
  name?: string;
  startTime: string;
  localDate: string;
  durationSeconds?: number;
  movingTimeSeconds?: number;
  distanceMeters?: number;
  avgPaceSecondsPerKm?: number;
  avgHeartRateBpm?: number;
  trainingLoad?: number;
  sourceRecords: { provider: string; externalId: string; contributedFields: string[] }[];
  sourceConfidence: number;
}

export interface WorkoutDetail extends WorkoutSummary {
  analysis?: {
    execution: { adherence?: number; notes: string[] };
    efficiency?: { efficiencyFactor: number };
    decoupling?: { driftPercent: number; isValid: boolean; invalidReason?: string; interpretation: string };
    trainingEffect: { trainingLoad?: number; loadModel?: string };
    insight: string;
  };
}

export interface TrendDto {
  metric: string;
  direction: 'improving' | 'stable' | 'declining' | 'insufficient_data';
  percentChange?: number;
  confidence: 'low' | 'moderate' | 'high';
  summary: string;
}

export interface ProgressResponse {
  windowDays: number;
  fitness: {
    estimatedVo2Max?: number;
    thresholdPaceSecondsPerKm?: number;
    easyPaceRangeSecondsPerKm?: [number, number];
    confidence: 'low' | 'moderate' | 'high';
    basis: string;
    aerobicEfficiency?: TrendDto & { summary: string };
  };
  training: {
    weeklyDistance: { date: string; value: number }[];
    weeklyLoad: { date: string; value: number }[];
    longestRun: { date: string; value: number }[];
    distanceTrend?: TrendDto;
  };
  recovery: {
    recoveryScore: { date: string; value: number }[];
    hrv: { date: string; value: number }[];
    restingHeartRate: { date: string; value: number }[];
    sleepHours: { date: string; value: number }[];
    hrvTrend?: TrendDto;
    restingHrTrend?: TrendDto;
  };
  body: { weightKilograms: { date: string; value: number }[]; weightTrend?: TrendDto };
  racePredictions: {
    distanceMeters: number;
    label: string;
    predictedDurationSeconds: number;
    predictedPaceSecondsPerKm: number;
    confidence: 'low' | 'moderate' | 'high';
    method: string;
    basis: string;
  }[];
}

export interface RaceGoal {
  id: string;
  name: string;
  date: string;
  distanceMeters: number;
  targetDurationSeconds?: number;
  weeksRemaining: number;
  targetPaceSecondsPerKm?: number;
  currentEstimateSeconds?: number;
  gapSeconds?: number;
  confidence: 'low' | 'moderate' | 'high';
  targetLooksUnrealistic: boolean;
  note: string;
  readiness?: {
    score: number;
    summary: string;
    factors: { key: string; label: string; score: number; detail: string }[];
  };
}

export interface WeeklyReview {
  weekKey: string;
  weekStart: string;
  headline: string;
  assessment: string;
  completionRate: number;
  distanceChangePercent?: number;
  averageRecoveryScore?: number;
  summary: {
    completedDistanceMeters: number;
    plannedDistanceMeters: number;
    completedSessions: number;
    plannedSessions: number;
    longestRunMeters: number;
    qualitySessions: number;
  };
  whatWentWell: string[];
  whatNeedsAttention: string[];
  keyAdaptation: string;
  nextWeekPriority: string;
}

export interface Connection {
  provider: string;
  displayName: string;
  status: 'connected' | 'disconnected' | 'expired' | 'error' | 'syncing';
  connectedAt?: string;
  lastSyncedAt?: string;
  lastSyncError?: string;
  dataDescription: string[];
  isConfigured: boolean;
  capabilities: { serverPull: boolean; webhooks: boolean };
  lastSync?: { status: string; recordsFetched: number; duplicatesMerged: number; errors: string[] };
}

export interface SyncResult {
  provider: string;
  status: string;
  recordsFetched: number;
  duplicatesMerged: number;
  errors: string[];
}

export interface CoachResponse {
  answer: string;
  claims?: { kind: string; text: string }[];
  keyMetrics?: { label: string; value: string; context?: string }[];
  recommendation?: string;
  confidence?: 'low' | 'moderate' | 'high';
  dataUsed?: string[];
  warnings?: string[];
  generatedWithoutLlm?: boolean;
}

export interface CoachHistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}
