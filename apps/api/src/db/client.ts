/**
 * Database client.
 *
 * Two drivers, one schema:
 *   - `postgres` for real deployments (Supabase, RDS, Neon...).
 *   - PGlite (embedded Postgres compiled to WASM) for local development and
 *     tests, so contributors and CI can run the full stack — migrations,
 *     constraints, transactions — with no external service. It speaks the same
 *     SQL dialect, so a query that works in tests works in production.
 */

import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { drizzle as drizzlePostgres, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { PGlite } from '@electric-sql/pglite';
import { mkdirSync } from 'node:fs';
import postgres from 'postgres';

import { schema } from './schema.js';
import { env } from '../env.js';

export type Database = PgliteDatabase<typeof schema> | PostgresJsDatabase<typeof schema>;

interface Handle {
  db: Database;
  /** Underlying driver, exposed only for migration and shutdown. */
  raw: PGlite | ReturnType<typeof postgres>;
  kind: 'pglite' | 'postgres';
  close: () => Promise<void>;
}

let handle: Handle | undefined;

/**
 * Open (or reuse) the process-wide database connection.
 *
 * @param options.dataDir overrides PGLITE_DIR; pass `'memory://'` for tests.
 */
export async function getDb(options: { dataDir?: string } = {}): Promise<Handle> {
  if (handle) return handle;

  const config = env();

  if (config.DATABASE_URL) {
    const client = postgres(config.DATABASE_URL, {
      max: 10,
      // Health data queries should fail fast rather than pile up.
      connect_timeout: 10,
    });
    handle = {
      db: drizzlePostgres(client, { schema }),
      raw: client,
      kind: 'postgres',
      close: async () => {
        await client.end();
        handle = undefined;
      },
    };
    return handle;
  }

  const dataDir = options.dataDir ?? config.PGLITE_DIR;

  // PGlite only creates the final directory, not intermediate ones, so a
  // nested default like `.data/pglite` fails on a clean checkout.
  if (!dataDir.startsWith('memory://')) {
    mkdirSync(dataDir, { recursive: true });
  }

  const client = new PGlite(dataDir);
  await client.waitReady;

  handle = {
    db: drizzlePglite(client, { schema }),
    raw: client,
    kind: 'pglite',
    close: async () => {
      await client.close();
      handle = undefined;
    },
  };
  return handle;
}

/** Reset the cached handle. Tests use this between suites. */
export function resetDbForTesting(): void {
  handle = undefined;
}
