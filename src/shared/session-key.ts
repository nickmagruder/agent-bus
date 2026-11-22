import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Per-session secret keys (#65). The platform token says which app is
 * calling; the key proves which session. The broker hands a key to the
 * session's own context (SessionStart, UserPromptSubmit) or `register`
 * result and keeps only its SHA-256 hash, so a key can't be read back from
 * the database, the audit log or the log files. Handing a session a new key
 * replaces the old one.
 */

/** Prefix that makes a key easy to spot (and to redact) in text. */
export const SESSION_KEY_PREFIX = 'abk_';

/** 32 random bytes, base64url: `abk_` + 43 characters. */
export const SESSION_KEY_PATTERN = /^abk_[A-Za-z0-9_-]{43}$/;

export function mintSessionKey(): string {
  return SESSION_KEY_PREFIX + randomBytes(32).toString('base64url');
}

/**
 * The stored form. The key is 256 random bits, so a plain SHA-256 is enough:
 * there is nothing to guess, and nothing a slow hash would protect.
 */
export function hashSessionKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Whether `key` hashes to `storedHash`, compared in constant time. */
export function sessionKeyMatches(key: string, storedHash: string): boolean {
  const given = Buffer.from(hashSessionKey(key), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return given.length === stored.length && timingSafeEqual(given, stored);
}
