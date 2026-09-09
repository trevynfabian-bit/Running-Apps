/**
 * Photo storage for body composition sessions.
 *
 * Photo bytes never go in the database: the row keeps a storage key and the
 * bytes live behind this small interface. The filesystem implementation on a
 * persistent volume is enough for a personal deployment; an object store
 * (S3, R2, Supabase Storage) slots in behind the same three methods without
 * touching the routes.
 *
 * Keys are chosen by the caller and scoped by athlete
 * (`athletes/<athleteId>/sessions/<sessionId>/<side>.<ext>`), and the local
 * store refuses any key that would escape its root.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import { env } from '../env.js';

// ---------------------------------------------------------------------------
// Image inspection
// ---------------------------------------------------------------------------

export type ImageKind = 'jpeg' | 'png' | 'webp' | 'heic';

export interface ImageInfo {
  kind: ImageKind;
  contentType: string;
  extension: string;
  widthPx?: number;
  heightPx?: number;
}

const ascii = (bytes: Uint8Array, start: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(start, start + length));

const u16be = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Uint8Array, i: number): number =>
  ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u16le = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);

function jpegDimensions(b: Uint8Array): { widthPx: number; heightPx: number } | undefined {
  // Walk the marker segments until a start-of-frame, which carries the size.
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // standalone marker, no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined; // end of image / scan data
    const length = u16be(b, i + 2);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 8 >= b.length) return undefined;
      return { heightPx: u16be(b, i + 5), widthPx: u16be(b, i + 7) };
    }
    i += 2 + length;
  }
  return undefined;
}

function webpDimensions(b: Uint8Array): { widthPx: number; heightPx: number } | undefined {
  if (b.length < 30) return undefined;
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X') {
    return { widthPx: 1 + u24le(b, 24), heightPx: 1 + u24le(b, 27) };
  }
  if (chunk === 'VP8 ') {
    return { widthPx: u16le(b, 26) & 0x3fff, heightPx: u16le(b, 28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const b0 = b[21]!;
    const b1 = b[22]!;
    const b2 = b[23]!;
    const b3 = b[24]!;
    return {
      widthPx: 1 + (((b1 & 0x3f) << 8) | b0),
      heightPx: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | (b1 >> 6)),
    };
  }
  return undefined;
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);

/**
 * Identify an image from its bytes, not from what the client says it is, and
 * read its dimensions where the format makes that cheap. Anything else is
 * refused before it reaches storage.
 */
export function inspectImage(bytes: Uint8Array): ImageInfo | undefined {
  if (bytes.length < 12) return undefined;

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: 'jpeg', contentType: 'image/jpeg', extension: 'jpg', ...jpegDimensions(bytes) };
  }
  if (ascii(bytes, 1, 3) === 'PNG' && bytes[0] === 0x89) {
    const dims =
      bytes.length >= 24 && ascii(bytes, 12, 4) === 'IHDR'
        ? { widthPx: u32be(bytes, 16), heightPx: u32be(bytes, 20) }
        : {};
    return { kind: 'png', contentType: 'image/png', extension: 'png', ...dims };
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return { kind: 'webp', contentType: 'image/webp', extension: 'webp', ...webpDimensions(bytes) };
  }
  if (ascii(bytes, 4, 4) === 'ftyp' && HEIC_BRANDS.has(ascii(bytes, 8, 4))) {
    return { kind: 'heic', contentType: 'image/heic', extension: 'heic' };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface PhotoStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  remove(key: string): Promise<void>;
}

export class LocalPhotoStore implements PhotoStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    const path = resolve(this.root, key);
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error(`photo store: key escapes the store root`);
    }
    return path;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    // Write beside the target and rename, so a reader never sees a partial file.
    const staging = `${path}.${randomUUID()}.tmp`;
    await writeFile(staging, bytes);
    await rename(staging, path);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}

let store: PhotoStore | undefined;

export function getPhotoStore(): PhotoStore {
  store ??= new LocalPhotoStore(env().BODY_PHOTO_DIR);
  return store;
}

/** Test hook: replace (or reset) the process-wide store. */
export function setPhotoStoreForTesting(next: PhotoStore | undefined): void {
  store = next;
}
