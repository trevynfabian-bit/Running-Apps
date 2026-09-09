/**
 * Hono application assembly.
 *
 * Exported separately from the server bootstrap so tests can exercise the full
 * routing stack via `app.request(...)` without binding a port.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ZodError } from 'zod';

import { API_ERROR_CODES } from '@running/contracts';
import { ApiError } from './errors.js';
import { authRoutes } from './routes/auth.js';
import { appRoutes } from './routes/app.js';
import { bodyCompositionRoutes } from './routes/body-composition.js';
import { connectionRoutes } from './routes/connections.js';
import { webhookRoutes } from './routes/webhooks.js';
import { logger } from './observability/logger.js';
import { requireAuth } from './security/auth.js';

export function createApp(): Hono {
  const app = new Hono();

  app.use(
    '*',
    cors({
      // The mobile app has no browser origin; CORS matters only for the
      // OAuth callback pages and local web development.
      origin: (origin) => origin ?? '*',
      allowHeaders: ['Content-Type', 'Authorization'],
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    }),
  );

  // Request logging, without bodies — they contain health data.
  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    logger.debug('http.request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - started,
    });
  });

  app.get('/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }));

  /**
   * Single authentication boundary.
   *
   * Declared here rather than inside each router because a sub-app mounted at
   * `/api` that does `use('*', requireAuth())` also captures `/api/webhooks/*`
   * and `/api/connections/:provider/callback` — neither of which can carry a
   * bearer token. Strava and WHOOP would receive 401s and disable the
   * subscription.
   *
   * The list below is an explicit allowlist and the default is to require
   * auth, so a new route is protected unless someone deliberately opens it.
   */
  const PUBLIC_PATHS: readonly RegExp[] = [
    /^\/api\/auth\//,
    /^\/api\/webhooks\//,
    // The OAuth redirect arrives from the provider's browser, carrying a
    // signed `state` parameter instead of a session.
    /^\/api\/connections\/[^/]+\/callback$/,
  ];

  app.use('/api/*', async (c, next) => {
    if (PUBLIC_PATHS.some((pattern) => pattern.test(c.req.path))) return next();
    return requireAuth()(c as never, next);
  });

  app.route('/api/auth', authRoutes);
  app.route('/api/connections', connectionRoutes);
  app.route('/api/webhooks', webhookRoutes);
  app.route('/api/body-composition', bodyCompositionRoutes);
  app.route('/api', appRoutes);

  /**
   * Error boundary.
   *
   * Athletes see a stable code and a sentence written for a person. Stack
   * traces and provider internals stay in the logs.
   */
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json(error.toBody(), error.status as 400);
    }

    if (error instanceof ZodError) {
      return c.json(
        {
          error: {
            code: API_ERROR_CODES.VALIDATION_FAILED,
            message: 'Some of the values sent were not valid.',
            details: { issues: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
          },
        },
        400,
      );
    }

    logger.error('http.unhandled_error', {
      path: c.req.path,
      method: c.req.method,
      error: error.message,
      stack: error.stack,
    });

    return c.json(
      {
        error: {
          code: API_ERROR_CODES.INTERNAL,
          message: 'Something went wrong on our side. Your data is safe — please try again.',
        },
      },
      500,
    );
  });

  app.notFound((c) =>
    c.json(
      { error: { code: API_ERROR_CODES.NOT_FOUND, message: 'That endpoint does not exist.' } },
      404,
    ),
  );

  return app;
}
