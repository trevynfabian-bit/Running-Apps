/**
 * Composition photo storage.
 *
 * Body photos are the most sensitive thing this product holds. Three rules
 * follow from that, and they are enforced here rather than trusted to callers:
 *
 *   The server mints every storage key. A key supplied by the device is a way
 *   for one athlete's session to point at another athlete's file, so the only
 *   input taken from the caller is the athlete, session and side — the path is
 *   derived, and includes a random component so a key cannot be guessed from
 *   ids the client already knows.
 *
 *   The declared content type is not believed. A client can put `image/jpeg` on
 *   an SVG, which is a stored-XSS payload the moment it is served back; the
 *   bytes are checked against known image signatures and the declared type must
 *   agree with what the file actually is.
 *
 *   Deletion is a first-class operation, by photo, by session, and by athlete.
 *   The database cascades rows; something has to cascade the files, and
 *   "delete everything for this athlete" has to work without first enumerating
 *   rows that may already be gone.
 *
 * One interface, two drivers — the same shape as the database client. The
 * filesystem driver backs development and tests; an object-store driver can be
 * added without any calling code changing.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { badRequest, photoTooLarge, unsupportedPhotoType } from '../errors.js';
import { env } from '../env.js';
import { logger } from '../observability/logger.js';

export const PHOTO_SIDES = ['front', 'back', 'left', 'right'] as const;
export type PhotoSide = (typeof PHOTO_SIDES)[number];

export function isPhotoSide(value: string): value is PhotoSide {
  return (PHOTO_SIDES as readonly string[]).includes(value);
}

/**
 * Accepted image types and the extension each is stored under.
 *
 * The extension is what read-back uses to report a content type, so the map is
 * the single source of truth in both directions. SVG is deliberately absent: it
 * is a document that can carry script, not a photograph.
 */
const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
} as const;

export type PhotoContentType = keyof typeof IMAGE_TYPES;

export const SUPPORTED_PHOTO_TYPES = Object.keys(IMAGE_TYPES) as readonly PhotoContentType[];

const EXTENSION_TO_TYPE = new Map<string, PhotoContentType>(
  (Object.entries(IMAGE_TYPES) as [PhotoContentType, string][]).map(([type, ext]) => [ext, type]),
);

export interface StoredPhoto {
  /** Server-minted key. The only thing a caller should persist. */
  storageKey: string;
  contentType: PhotoContentType;
  byteSize: number;
  /** SHA-256 of the bytes, so a retake that changes nothing is detectable. */
  checksum: string;
}

export interface PhotoStorage {
  readonly kind: 'filesystem';
  put(input: {
    athleteId: string;
    sessionId: string;
    side: PhotoSide;
    contentType: string;
    bytes: Uint8Array;
  }): Promise<StoredPhoto>;
  read(storageKey: string): Promise<{ bytes: Buffer; contentType: PhotoContentType } | undefined>;
  /** Returns false when the object was already gone. */
  remove(storageKey: string): Promise<boolean>;
  /** Delete every photo in one session. Returns how many were removed. */
  removeSession(athleteId: string, sessionId: string): Promise<number>;
  /** Delete every photo an athlete has, across all sessions. */
  removeAthlete(athleteId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Leading bytes that identify each accepted format.
 *
 * Enough to tell a real photo from a renamed document. This is not a full image
 * parser and does not try to be — it exists to stop a text payload being stored
 * and later served under an image content type.
 */
function sniff(bytes: Uint8Array): PhotoContentType | undefined {
  const startsWith = (...signature: number[]): boolean =>
    signature.every((byte, index) => bytes[index] === byte);

  // JPEG: FF D8 FF
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';

  // RIFF....WEBP — the size field sits between the two markers.
  const ascii = (offset: number, text: string): boolean =>
    [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';

  // ISO base media: ....ftyp then a HEIC-family brand.
  if (ascii(4, 'ftyp')) {
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) {
      return 'image/heic';
    }
  }

  return undefined;
}

/**
 * Key shape, checked before any path is built from it.
 *
 * Anchored and without a dot segment, so a crafted key cannot walk out of the
 * storage root. The resolved path is checked against the root as well — belt
 * and braces, because a single regex is a thin thing to hang file deletion on.
 */
const KEY_PATTERN =
  /^composition\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/(front|back|left|right)-[0-9a-f]{16}\.(jpg|png|webp|heic)$/;

function assertSafeKey(storageKey: string): void {
  if (!KEY_PATTERN.test(storageKey)) {
    throw badRequest('That photo reference is not valid.');
  }
}

function extensionOf(storageKey: string): PhotoContentType {
  const ext = storageKey.slice(storageKey.lastIndexOf('.') + 1);
  const type = EXTENSION_TO_TYPE.get(ext);
  // Unreachable while assertSafeKey runs first; a thrown error beats a cast.
  if (!type) throw badRequest('That photo reference is not valid.');
  return type;
}

/**
 * Validate an upload and decide what it will be stored as.
 *
 * Exported because the route layer wants the same answer before it writes a
 * database row, and duplicating the rules is how the two drift apart.
 */
export function validatePhotoUpload(input: {
  contentType: string;
  bytes: Uint8Array;
}): PhotoContentType {
  const maxBytes = env().PHOTO_MAX_BYTES;

  if (input.bytes.byteLength === 0) throw badRequest('That photo is empty.');
  if (input.bytes.byteLength > maxBytes) throw photoTooLarge(maxBytes);

  const declared = input.contentType.split(';')[0]!.trim().toLowerCase();
  if (!(declared in IMAGE_TYPES)) {
    throw unsupportedPhotoType(declared, SUPPORTED_PHOTO_TYPES);
  }

  const actual = sniff(input.bytes);
  if (!actual) throw unsupportedPhotoType(declared, SUPPORTED_PHOTO_TYPES);

  // A mismatch is either a broken client or a deliberate attempt to have the
  // server serve something back under a type it is not. Both are refused, and
  // the athlete-facing message does not distinguish them.
  if (actual !== declared) throw unsupportedPhotoType(declared, SUPPORTED_PHOTO_TYPES);

  return actual;
}

// ---------------------------------------------------------------------------
// Filesystem driver
// ---------------------------------------------------------------------------

function athletePrefix(athleteId: string): string {
  return path.posix.join('composition', athleteId);
}

function sessionPrefix(athleteId: string, sessionId: string): string {
  return path.posix.join(athletePrefix(athleteId), sessionId);
}

/**
 * Build a key for a new object.
 *
 * The random component means a retake never reuses the key of the photo it
 * replaces. That matters beyond guessability: an object store or CDN that has
 * already cached the old key would otherwise keep serving the old body photo
 * after the athlete deliberately replaced it.
 */
function mintKey(athleteId: string, sessionId: string, side: PhotoSide, ext: string): string {
  return path.posix.join(
    sessionPrefix(athleteId, sessionId),
    `${side}-${randomBytes(8).toString('hex')}.${ext}`,
  );
}

function createFilesystemStorage(rootDir: string): PhotoStorage {
  const root = path.resolve(rootDir);

  /** Resolve a key inside the root, refusing anything that escapes it. */
  const resolve = (storageKey: string): string => {
    assertSafeKey(storageKey);
    const full = path.resolve(root, storageKey);
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw badRequest('That photo reference is not valid.');
    }
    return full;
  };

  /** Remove a directory tree, reporting how many files went with it. */
  const removeTree = async (prefix: string): Promise<number> => {
    const dir = path.resolve(root, prefix);
    if (dir !== root && !dir.startsWith(root + path.sep)) {
      throw badRequest('That photo reference is not valid.');
    }

    let removed = 0;
    try {
      // Counted before the delete: afterwards there is nothing left to count,
      // and the caller wants to know what it destroyed.
      for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
        if (entry.isFile()) removed += 1;
      }
    } catch (error) {
      // Nothing stored for this athlete or session is a success, not an error —
      // account deletion must not fail because there were never any photos.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }

    await rm(dir, { recursive: true, force: true });
    return removed;
  };

  return {
    kind: 'filesystem',

    async put(input) {
      const contentType = validatePhotoUpload(input);
      const storageKey = mintKey(
        input.athleteId,
        input.sessionId,
        input.side,
        IMAGE_TYPES[contentType],
      );

      const full = resolve(storageKey);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, input.bytes);

      return {
        storageKey,
        contentType,
        byteSize: input.bytes.byteLength,
        checksum: createHash('sha256').update(input.bytes).digest('hex'),
      };
    },

    async read(storageKey) {
      const full = resolve(storageKey);
      try {
        return { bytes: await readFile(full), contentType: extensionOf(storageKey) };
      } catch (error) {
        // A missing object is a 404 for the caller to shape, not a 500.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },

    async remove(storageKey) {
      const full = resolve(storageKey);
      try {
        await unlink(full);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },

    removeSession: (athleteId, sessionId) => removeTree(sessionPrefix(athleteId, sessionId)),

    removeAthlete: (athleteId) => removeTree(athletePrefix(athleteId)),
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

let cached: PhotoStorage | undefined;

/** The process-wide storage, built from configuration on first use. */
export function photoStorage(): PhotoStorage {
  if (!cached) {
    const dir = env().PHOTO_STORAGE_DIR;
    cached = createFilesystemStorage(dir);
    logger.info('photo-storage.ready', { driver: cached.kind });
  }
  return cached;
}

/** Test hook: drop the cached storage so the next call re-reads configuration. */
export function resetPhotoStorageForTesting(): void {
  cached = undefined;
}
