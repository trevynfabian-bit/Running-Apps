/**
 * Photo storage.
 *
 * Most of what follows is about refusing things: a content type that lies
 * about its bytes, a key crafted to walk out of the storage root, a file too
 * large to be a photo. Those are the parts worth a test — the happy path is
 * one write and one read.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadEnv, setEnvForTesting } from '../env.js';
import {
  PHOTO_SIDES,
  isPhotoSide,
  photoStorage,
  resetPhotoStorageForTesting,
  validatePhotoUpload,
} from './photo-storage.js';
import { ApiError } from '../errors.js';

const ATHLETE = '11111111-1111-1111-1111-111111111111';
const OTHER_ATHLETE = '22222222-2222-2222-2222-222222222222';
const SESSION = '33333333-3333-3333-3333-333333333333';
const OTHER_SESSION = '44444444-4444-4444-4444-444444444444';

let root: string;

/** Smallest byte sequences that carry each format's signature. */
const jpeg = (): Uint8Array => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const png = (): Uint8Array =>
  Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const webp = (): Uint8Array =>
  Uint8Array.from(
    [...'RIFF']
      .map((c) => c.charCodeAt(0))
      .concat(
        [0x00, 0x00, 0x00, 0x00],
        [...'WEBP'].map((c) => c.charCodeAt(0)),
      ),
  );
const heic = (): Uint8Array =>
  Uint8Array.from(
    [0x00, 0x00, 0x00, 0x18].concat(
      [...'ftyp'].map((c) => c.charCodeAt(0)),
      [...'heic'].map((c) => c.charCodeAt(0)),
    ),
  );

function configure(overrides: Record<string, unknown> = {}): void {
  setEnvForTesting(
    loadEnv({
      NODE_ENV: 'test',
      USE_MOCK_DATA: true,
      DATABASE_URL: '',
      AUTH_JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
      TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
      AI_API_KEY: '',
      PHOTO_STORAGE_DIR: root,
      ...overrides,
    }),
  );
  resetPhotoStorageForTesting();
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'running-os-photos-'));
  configure();
});

afterEach(() => configure());

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  setEnvForTesting(undefined);
  resetPhotoStorageForTesting();
});

describe('sides', () => {
  it('knows the four it accepts', () => {
    expect([...PHOTO_SIDES]).toEqual(['front', 'back', 'left', 'right']);
    expect(isPhotoSide('front')).toBe(true);
    expect(isPhotoSide('top')).toBe(false);
  });
});

describe('validation', () => {
  it('accepts each supported format when the bytes agree', () => {
    expect(validatePhotoUpload({ contentType: 'image/jpeg', bytes: jpeg() })).toBe('image/jpeg');
    expect(validatePhotoUpload({ contentType: 'image/png', bytes: png() })).toBe('image/png');
    expect(validatePhotoUpload({ contentType: 'image/webp', bytes: webp() })).toBe('image/webp');
    expect(validatePhotoUpload({ contentType: 'image/heic', bytes: heic() })).toBe('image/heic');
  });

  it('tolerates a charset parameter and odd casing on the declared type', () => {
    expect(validatePhotoUpload({ contentType: 'IMAGE/JPEG; charset=binary', bytes: jpeg() })).toBe(
      'image/jpeg',
    );
  });

  it('refuses bytes that do not match the declared type', () => {
    // A PNG announced as JPEG is a broken client at best.
    expect(() => validatePhotoUpload({ contentType: 'image/jpeg', bytes: png() })).toThrow(
      ApiError,
    );
  });

  it('refuses a document wearing an image content type', () => {
    // The stored-XSS case: an SVG served back as image/* is script.
    const svg = new TextEncoder().encode('<svg onload="alert(1)"></svg>');
    expect(() => validatePhotoUpload({ contentType: 'image/png', bytes: svg })).toThrow(ApiError);
  });

  it('refuses a type that is not an accepted image', () => {
    expect(() => validatePhotoUpload({ contentType: 'image/svg+xml', bytes: jpeg() })).toThrow(
      ApiError,
    );
    expect(() => validatePhotoUpload({ contentType: 'application/pdf', bytes: jpeg() })).toThrow(
      ApiError,
    );
  });

  it('refuses an empty file', () => {
    expect(() =>
      validatePhotoUpload({ contentType: 'image/jpeg', bytes: new Uint8Array() }),
    ).toThrow(ApiError);
  });

  it('refuses a file over the configured limit', () => {
    configure({ PHOTO_MAX_BYTES: 16 });

    const big = new Uint8Array(64);
    big.set(jpeg());

    expect(() => validatePhotoUpload({ contentType: 'image/jpeg', bytes: big })).toThrow(
      expect.objectContaining({ status: 413 }) as Error,
    );

    // The same bytes are fine once the limit allows them.
    configure({ PHOTO_MAX_BYTES: 1024 });
    expect(validatePhotoUpload({ contentType: 'image/jpeg', bytes: big })).toBe('image/jpeg');
  });
});

describe('storing and reading', () => {
  it('round-trips a photo and reports its size and checksum', async () => {
    const stored = await photoStorage().put({
      athleteId: ATHLETE,
      sessionId: SESSION,
      side: 'front',
      contentType: 'image/jpeg',
      bytes: jpeg(),
    });

    expect(stored.contentType).toBe('image/jpeg');
    expect(stored.byteSize).toBe(jpeg().byteLength);
    expect(stored.checksum).toMatch(/^[0-9a-f]{64}$/);

    const read = await photoStorage().read(stored.storageKey);
    expect(read?.contentType).toBe('image/jpeg');
    expect(Uint8Array.from(read!.bytes)).toEqual(jpeg());
  });

  it('mints the key itself, scoped to athlete and session', async () => {
    const stored = await photoStorage().put({
      athleteId: ATHLETE,
      sessionId: SESSION,
      side: 'left',
      contentType: 'image/png',
      bytes: png(),
    });

    expect(stored.storageKey).toMatch(
      new RegExp(`^composition/${ATHLETE}/${SESSION}/left-[0-9a-f]{16}\\.png$`),
    );
  });

  it('never reuses a key, so a retake cannot be served from a stale cache', async () => {
    const first = await photoStorage().put({
      athleteId: ATHLETE,
      sessionId: SESSION,
      side: 'back',
      contentType: 'image/jpeg',
      bytes: jpeg(),
    });
    const retake = await photoStorage().put({
      athleteId: ATHLETE,
      sessionId: SESSION,
      side: 'back',
      contentType: 'image/jpeg',
      bytes: jpeg(),
    });

    expect(retake.storageKey).not.toBe(first.storageKey);
  });

  it('reports a missing object as absent rather than failing', async () => {
    const key = `composition/${ATHLETE}/${SESSION}/right-${'0'.repeat(16)}.jpg`;
    await expect(photoStorage().read(key)).resolves.toBeUndefined();
  });
});

describe('key safety', () => {
  const traversals = [
    '../../../etc/passwd',
    `composition/${ATHLETE}/../../../etc/passwd`,
    `composition/${ATHLETE}/${SESSION}/../../../../secret.jpg`,
    '/etc/passwd',
    `composition/${ATHLETE}/${SESSION}/front.jpg`,
    'composition/not-a-uuid/also-not/front-0000000000000000.jpg',
  ];

  it.each(traversals)('refuses to read through %s', async (key) => {
    await expect(photoStorage().read(key)).rejects.toThrow(ApiError);
  });

  it.each(traversals)('refuses to delete through %s', async (key) => {
    await expect(photoStorage().remove(key)).rejects.toThrow(ApiError);
  });

  it('leaves a file outside the root untouched', async () => {
    const outside = path.join(root, '..', 'running-os-photos-bystander.txt');
    await writeFile(outside, 'not a photo');

    await expect(photoStorage().remove('../running-os-photos-bystander.txt')).rejects.toThrow(
      ApiError,
    );

    // Still there.
    await expect(
      import('node:fs/promises').then((fs) => fs.readFile(outside, 'utf8')),
    ).resolves.toBe('not a photo');

    await rm(outside, { force: true });
  });
});

describe('deletion', () => {
  it('removes one photo and says whether there was one', async () => {
    const stored = await photoStorage().put({
      athleteId: ATHLETE,
      sessionId: SESSION,
      side: 'front',
      contentType: 'image/jpeg',
      bytes: jpeg(),
    });

    await expect(photoStorage().remove(stored.storageKey)).resolves.toBe(true);
    await expect(photoStorage().read(stored.storageKey)).resolves.toBeUndefined();
    // Deleting twice is not an error — a retry after a partial failure is fine.
    await expect(photoStorage().remove(stored.storageKey)).resolves.toBe(false);
  });

  it('removes a whole session without touching the athlete other sessions', async () => {
    const keep = await photoStorage().put({
      athleteId: ATHLETE,
      sessionId: OTHER_SESSION,
      side: 'front',
      contentType: 'image/jpeg',
      bytes: jpeg(),
    });
    for (const side of PHOTO_SIDES) {
      await photoStorage().put({
        athleteId: ATHLETE,
        sessionId: SESSION,
        side,
        contentType: 'image/jpeg',
        bytes: jpeg(),
      });
    }

    await expect(photoStorage().removeSession(ATHLETE, SESSION)).resolves.toBeGreaterThanOrEqual(4);
    await expect(photoStorage().read(keep.storageKey)).resolves.toBeDefined();
  });

  it('removes everything for one athlete without touching another', async () => {
    const mine = await photoStorage().put({
      athleteId: ATHLETE,
      sessionId: SESSION,
      side: 'front',
      contentType: 'image/jpeg',
      bytes: jpeg(),
    });
    const theirs = await photoStorage().put({
      athleteId: OTHER_ATHLETE,
      sessionId: SESSION,
      side: 'front',
      contentType: 'image/jpeg',
      bytes: jpeg(),
    });

    await expect(photoStorage().removeAthlete(ATHLETE)).resolves.toBeGreaterThan(0);

    await expect(photoStorage().read(mine.storageKey)).resolves.toBeUndefined();
    await expect(photoStorage().read(theirs.storageKey)).resolves.toBeDefined();
  });

  it('treats deleting an athlete with no photos as success', async () => {
    // Account deletion must not fail because there was never anything stored.
    await expect(
      photoStorage().removeAthlete('99999999-9999-9999-9999-999999999999'),
    ).resolves.toBe(0);
  });
});
