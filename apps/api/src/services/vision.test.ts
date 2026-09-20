/**
 * The three states have to stay distinguishable: sending someone to retry a
 * service that was never configured, or to give up on one that is briefly
 * down, are both worse than saying nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadEnv, setEnvForTesting } from '../env.js';
import {
  FAILURE_WINDOW_MS,
  PHOTO_MARGIN,
  analysePhotos,
  isVisionConfigured,
  recordVisionFailure,
  recordVisionSuccess,
  resetVisionStateForTesting,
  visionStatus,
} from './vision.js';

function configure(overrides: Record<string, unknown> = {}): void {
  setEnvForTesting(
    loadEnv({
      NODE_ENV: 'test',
      USE_MOCK_DATA: true,
      DATABASE_URL: '',
      AUTH_JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
      TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
      AI_API_KEY: '',
      ...overrides,
    }),
  );
  resetVisionStateForTesting();
}

beforeEach(() => configure());
afterEach(() => {
  setEnvForTesting(undefined);
  resetVisionStateForTesting();
});

describe('with no service configured', () => {
  it('reports unavailable rather than failed', () => {
    const report = visionStatus();

    // Nothing is broken and nothing will fix itself; telling someone to retry
    // would waste their time.
    expect(report.status).toBe('unavailable');
    expect(report.configured).toBe(false);
    expect(isVisionConfigured()).toBe(false);
  });

  it('points at the formula instead of apologising', () => {
    const report = visionStatus();

    expect(report.suggestFormula).toBe(true);
    expect(report.message).toContain('measurements method');
  });

  it('stays unavailable even after a recorded failure', () => {
    recordVisionFailure('nothing to call');
    expect(visionStatus().status).toBe('unavailable');
  });
});

describe('with a service configured', () => {
  beforeEach(() => configure({ VISION_API_KEY: 'test-key' }));

  it('reports active when nothing has failed', () => {
    const report = visionStatus();

    expect(report.status).toBe('active');
    expect(report.configured).toBe(true);
    expect(report.suggestFormula).toBe(false);
  });

  it('reports failed after a recent failure', () => {
    recordVisionFailure('upstream timeout');
    const report = visionStatus();

    expect(report.status).toBe('failed');
    // Worth retrying, unlike unavailable — and the photos are safe.
    expect(report.message).toContain('trying again is safe');
    expect(report.suggestFormula).toBe(true);
    expect(report.lastFailureAt).toBeDefined();
  });

  it('recovers once the failure window passes', () => {
    const failedAt = new Date('2026-09-20T12:00:00.000Z');
    recordVisionFailure('upstream timeout', failedAt);

    const during = new Date(failedAt.getTime() + FAILURE_WINDOW_MS - 1000);
    const after = new Date(failedAt.getTime() + FAILURE_WINDOW_MS + 1000);

    // Long enough that an immediate retry sees the same answer; short enough
    // that a recovered service is not written off for the day.
    expect(visionStatus(during).status).toBe('failed');
    expect(visionStatus(after).status).toBe('active');
  });

  it('clears a failure as soon as a read succeeds', () => {
    recordVisionFailure('upstream timeout');
    expect(visionStatus().status).toBe('failed');

    recordVisionSuccess();
    expect(visionStatus().status).toBe('active');
  });

  it('never puts the failure reason in the athlete-facing message', () => {
    recordVisionFailure('connect ECONNREFUSED 10.0.0.4:443 for provider foo');
    const report = visionStatus();

    // Provider detail belongs in the log, not on a screen.
    expect(report.message).not.toContain('ECONNREFUSED');
    expect(report.message).not.toContain('10.0.0.4');
    expect(report.message).not.toContain('foo');
  });

  it('never reports anything about the credential', () => {
    const report = visionStatus();

    expect(JSON.stringify(report)).not.toContain('test-key');
    expect(report).not.toHaveProperty('apiKey');
    expect(report).not.toHaveProperty('baseUrl');
  });
});

describe('analysePhotos', () => {
  it('refuses without a configured service, without reaching the network', async () => {
    const result = await analysePhotos([
      { side: 'front', contentType: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff]) },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('configured');
  });

  it('refuses an empty photo set', async () => {
    configure({ VISION_API_KEY: 'test-key' });

    const result = await analysePhotos([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('no photos');
  });

  it('claims a wider band than either circumference equation', async () => {
    const { NAVY_STANDARD_ERROR, YMCA_STANDARD_ERROR } = await import('@running/core');

    // A photograph is the weakest signal on offer — lighting, posture and
    // clothing all move the answer — and the band has to say so.
    expect(PHOTO_MARGIN).toBeGreaterThan(NAVY_STANDARD_ERROR);
    expect(PHOTO_MARGIN).toBeGreaterThanOrEqual(YMCA_STANDARD_ERROR);
  });
});
