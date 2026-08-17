/**
 * Cryptography for credentials at rest and in transit.
 *
 * Provider OAuth tokens are the keys to an athlete's entire health history, so
 * they are encrypted with AES-256-GCM before they touch the database. GCM is
 * chosen over CBC because it authenticates the ciphertext: a tampered token
 * fails to decrypt rather than decrypting to garbage.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

import { env } from '../env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce, the GCM standard
const AUTH_TAG_LENGTH = 16;

/**
 * Resolve the 32-byte encryption key.
 *
 * In development an absent key is derived deterministically so the app runs
 * out of the box; `loadEnv` already refuses to start production without a real
 * key, so this fallback can never apply to real athlete data.
 */
function encryptionKey(): Buffer {
  const configured = env().TOKEN_ENCRYPTION_KEY;
  if (configured && configured.length >= 64) {
    return Buffer.from(configured.slice(0, 64), 'hex');
  }
  return scryptSync('running-os-development-key', 'running-os-dev-salt', 32);
}

/**
 * Encrypt a secret. Output is `iv:authTag:ciphertext`, all base64url.
 * Returns undefined for undefined input so callers can pass optional tokens
 * through without branching.
 */
export function encryptSecret(plaintext: string): string;
export function encryptSecret(plaintext: string | undefined): string | undefined;
export function encryptSecret(plaintext: string | undefined): string | undefined {
  if (plaintext === undefined) return undefined;

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

/**
 * Decrypt a secret produced by `encryptSecret`.
 * Throws on tampering or a wrong key — never returns partial plaintext.
 */
export function decryptSecret(payload: string): string;
export function decryptSecret(payload: string | null | undefined): string | undefined;
export function decryptSecret(payload: string | null | undefined): string | undefined {
  if (payload === null || payload === undefined) return undefined;

  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('decryptSecret: malformed ciphertext envelope');
  }

  const [ivPart, tagPart, dataPart] = parts as [string, string, string];
  const iv = Buffer.from(ivPart, 'base64url');
  const authTag = Buffer.from(tagPart, 'base64url');
  const ciphertext = Buffer.from(dataPart, 'base64url');

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('decryptSecret: malformed ciphertext envelope');
  }

  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

const SCRYPT_KEYLEN = 64;
/**
 * scrypt cost parameters. N=2^15 is a reasonable interactive-login cost:
 * roughly 100 ms per hash on server hardware, which is slow enough to make
 * offline cracking expensive without making sign-in feel sluggish.
 */
const SCRYPT_PARAMS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const salt = Buffer.from(parts[1]!, 'base64url');
  const expected = Buffer.from(parts[2]!, 'base64url');

  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, expected.length, SCRYPT_PARAMS);
  } catch {
    return false;
  }

  // Constant-time comparison to avoid leaking the hash through timing.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

/**
 * Verify an HMAC-SHA256 webhook signature in constant time.
 *
 * WHOOP signs webhooks with a shared secret over `timestamp + rawBody`.
 * The raw body must be used verbatim: re-serialising parsed JSON changes key
 * order and whitespace, which changes the digest.
 */
export function verifyHmacSignature(args: {
  secret: string;
  payload: string;
  signature: string;
  encoding?: 'base64' | 'hex';
}): boolean {
  const encoding = args.encoding ?? 'base64';
  const computed = createHmac('sha256', args.secret).update(args.payload, 'utf8').digest(encoding);

  const a = Buffer.from(computed);
  const b = Buffer.from(args.signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Cryptographically random state parameter for OAuth flows. */
export function generateOAuthState(): string {
  return randomBytes(32).toString('base64url');
}
