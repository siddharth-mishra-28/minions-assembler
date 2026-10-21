import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * At-rest encryption for provider API keys.
 *
 * Secrets live only in the local SQLite DB, AES-256-GCM encrypted. The master key
 * is generated once into `<data>/.master-key` (gitignored with data/) and never
 * leaves the machine. Literal `providerApiKey` values are sealed into `enc:v1:`
 * tokens before they touch definition JSON at rest.
 */

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

function keyPath(): string {
  return join(process.env.MINIONS_DATA_DIR || './data', '.master-key');
}

/** Load the master key, generating it on first use. */
export function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const path = keyPath();
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8').trim();
    const key = Buffer.from(raw, 'hex');
    if (key.length !== KEY_BYTES) throw new Error(`Corrupt master key at ${path} — expected ${KEY_BYTES} bytes hex`);
    cachedKey = key;
    return key;
  }
  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(KEY_BYTES);
  // Owner-only where the platform supports it.
  try { writeFileSync(path, key.toString('hex') + '\n', { mode: 0o600 }); }
  catch { writeFileSync(path, key.toString('hex') + '\n'); }
  cachedKey = key;
  return key;
}

export interface EncryptedSecret { ciphertext: string; iv: string; tag: string }

/** Encrypt a UTF-8 secret. Output is base64 fields safe to store in SQLite. */
export function encryptSecret(plain: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    ciphertext: enc.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

/** Decrypt a secret previously produced by encryptSecret(). */
export function decryptSecret(s: EncryptedSecret): string {
  const decipher = createDecipheriv(ALGO, masterKey(), Buffer.from(s.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(s.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(s.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

/** True when a string looks like an API key rather than an env-var name. */
export function looksLikeSecret(value: string): boolean {
  return value.length >= 16 || /[=/.+_-]/.test(value);
}

const TOKEN_PREFIX = 'enc:v1:';

/** Compact `enc:v1:iv:tag:ciphertext` token safe to embed in definition JSON. */
export function encryptToToken(plain: string): string {
  const e = encryptSecret(plain);
  return `${TOKEN_PREFIX}${e.iv}:${e.tag}:${e.ciphertext}`;
}

export function isEncryptedToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX);
}

/** Inverse of encryptToToken. Throws on tampered/malformed tokens. */
export function decryptFromToken(token: string): string {
  if (!isEncryptedToken(token)) throw new Error('Not an enc:v1 token');
  const parts = token.slice(TOKEN_PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Malformed enc:v1 token');
  return decryptSecret({ iv: parts[0], tag: parts[1], ciphertext: parts[2] });
}

/**
 * Resolve a `providerApiKey` value to a plaintext secret.
 * Handles `enc:v1:` tokens, `${ENV_VAR}` references, and literal keys.
 */
export function resolveProviderApiKeyValue(value: string): string {
  if (isEncryptedToken(value)) return decryptFromToken(value);
  const envRef = value.match(/^\$\{([A-Z0-9_]+)\}$/);
  if (envRef) {
    const key = process.env[envRef[1]];
    if (!key) throw new Error(`Environment variable "${envRef[1]}" referenced by providerApiKey is not set`);
    return key;
  }
  return value;
}
