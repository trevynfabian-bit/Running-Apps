/**
 * Server bootstrap.
 */

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { env } from './env.js';
import { runMigrations } from './db/migrate.js';
import { processQueuedJobs } from './sync/engine.js';
import { logger } from './observability/logger.js';

/** How often the in-process worker drains the sync queue. */
const WORKER_INTERVAL_MS = 15_000;

async function main(): Promise<void> {
  const config = env();

  await runMigrations();

  const app = createApp();

  serve({ fetch: app.fetch, port: config.API_PORT }, (info) => {
    logger.info('server.started', {
      port: info.port,
      env: config.NODE_ENV,
      mockData: config.USE_MOCK_DATA,
      strava: config.stravaConfigured ? 'configured' : 'not configured',
      whoop: config.whoopConfigured ? 'configured' : 'not configured',
      ai: config.aiConfigured ? 'configured' : 'deterministic fallback',
    });
  });

  // In-process sync worker. The durable queue lives in `sync_jobs`, so moving
  // this to a separate process later changes only who calls it.
  const worker = setInterval(() => {
    void processQueuedJobs().catch((error: unknown) => {
      logger.error('worker.tick_failed', { error: String(error) });
    });
  }, WORKER_INTERVAL_MS);

  const shutdown = (signal: string): void => {
    logger.info('server.shutdown', { signal });
    clearInterval(worker);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  logger.error('server.failed_to_start', { error: String(error) });
  process.exit(1);
});
