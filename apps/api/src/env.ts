/**
 * Environment configuration.
 *
 * Parsed once at boot and validated, so a misconfigured deployment fails
 * immediately with a clear message rather than at the first request.
 *
 * Secrets live here and ONLY here on the server. Nothing in this module is
 * ever serialised into an API response.
 */

import { z } from 'zod';

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true'));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),

  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default('.data/pglite'),

  AUTH_JWT_SECRET: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),

  USE_MOCK_DATA: booleanish.default(true),

  STRAVA_CLIENT_ID: z.string().optional(),
  STRAVA_CLIENT_SECRET: z.string().optional(),
  STRAVA_REDIRECT_URI: z.string().optional(),
  STRAVA_WEBHOOK_VERIFY_TOKEN: z.string().optional(),

  WHOOP_CLIENT_ID: z.string().optional(),
  WHOOP_CLIENT_SECRET: z.string().optional(),
  WHOOP_REDIRECT_URI: z.string().optional(),
  WHOOP_WEBHOOK_SECRET: z.string().optional(),

  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-sonnet-4-5'),
  AI_BASE_URL: z.string().default('https://api.anthropic.com'),
});

export type Env = z.infer<typeof envSchema> & {
  /** True when a real Strava app is configured. */
  stravaConfigured: boolean;
  whoopConfigured: boolean;
  aiConfigured: boolean;
};

let cached: Env | undefined;

export function loadEnv(overrides: Record<string, unknown> = {}): Env {
  const parsed = envSchema.safeParse({ ...process.env, ...overrides });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;

  const stravaConfigured = Boolean(
    env.STRAVA_CLIENT_ID && env.STRAVA_CLIENT_SECRET && env.STRAVA_REDIRECT_URI,
  );
  const whoopConfigured = Boolean(
    env.WHOOP_CLIENT_ID && env.WHOOP_CLIENT_SECRET && env.WHOOP_REDIRECT_URI,
  );

  // Production must not run on development defaults for anything that
  // protects athlete data.
  if (env.NODE_ENV === 'production') {
    const missing: string[] = [];
    if (!env.AUTH_JWT_SECRET || env.AUTH_JWT_SECRET.length < 32) missing.push('AUTH_JWT_SECRET');
    if (!env.TOKEN_ENCRYPTION_KEY || env.TOKEN_ENCRYPTION_KEY.length < 64) {
      missing.push('TOKEN_ENCRYPTION_KEY (64 hex chars)');
    }
    if (!env.DATABASE_URL) missing.push('DATABASE_URL');
    if (missing.length > 0) {
      throw new Error(
        `Refusing to start in production without: ${missing.join(', ')}. ` +
          'See .env.example for how to generate these.',
      );
    }
  }

  return { ...env, stravaConfigured, whoopConfigured, aiConfigured: Boolean(env.AI_API_KEY) };
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test hook: replace the cached environment. */
export function setEnvForTesting(next: Env | undefined): void {
  cached = next;
}
